import { analyzeSession } from './analyzer';
import { planOrganization } from './organizer';
import { formatTranscript, isDreamEligible } from './transcript';
import {
  buildIndexEntries,
  dreamRoot,
  formatWikiFile,
  hashText,
  historyKey,
  indexJsonKey,
  indexMarkdownKey,
  isRetired,
  loadWikiIndex,
  parseWikiFile,
  pickRelevantEntries,
  readIndexJson,
  redactSecrets,
  renderIndexMarkdown,
  reportKey,
  safeScope,
  stateKey,
  wikiKey,
} from './wiki';
import type {
  DreamLlm,
  DreamOptions,
  DreamReport,
  DreamSessionResult,
  DreamState,
  DreamStorage,
  WikiFile,
  WikiIndexEntry,
  WikiIndexFile,
} from './types';

const DEFAULT_MAX_SESSIONS = 6;
const DEFAULT_MIN_IDLE_MS = 10 * 60_000;
const DEFAULT_MAX_FILES = 80;
const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const MAX_PROCESSED_SESSIONS = 400;
const MAX_BODY_CHARS = 12_000;
const HISTORY_KEEP_VERSIONS = 8;
const HISTORY_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_timeout`)), Math.max(1000, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function readState(raw: string | null): DreamState {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<DreamState>;
      if (parsed.schema === 1 && parsed.processed && typeof parsed.processed === 'object') {
        return {
          schema: 1,
          processed: parsed.processed as DreamState['processed'],
          lastRunAt: typeof parsed.lastRunAt === 'number' ? parsed.lastRunAt : null,
        };
      }
    } catch {
      // Corrupt state is recoverable: reprocess sessions instead of failing.
    }
  }
  return { schema: 1, processed: {}, lastRunAt: null };
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw).slice(0, 240);
}

async function loadFiles(
  storage: DreamStorage,
  scope: string,
  entries: WikiIndexEntry[],
  maxFiles: number,
  warnings: string[]
): Promise<Map<string, WikiFile>> {
  const files = new Map<string, WikiFile>();
  for (const entry of entries.slice(0, maxFiles)) {
    const file = parseWikiFile(await storage.getObject(wikiKey(scope, entry.slug)));
    if (file) files.set(file.slug, file);
    else warnings.push(`missing_wiki_file:${entry.slug}`);
  }
  if (entries.length > maxFiles) warnings.push('wiki_file_limit_reached');
  return files;
}

async function persistFile(
  storage: DreamStorage,
  scope: string,
  file: WikiFile,
  previous: WikiFile | undefined,
  now: number,
  warnings: string[]
): Promise<boolean> {
  if (previous) {
    const historyOk = await storage.putObject(historyKey(scope, file.slug, now), formatWikiFile(previous));
    if (!historyOk) warnings.push(`history_write_failed:${file.slug}`);
  }
  const ok = await storage.putObject(wikiKey(scope, file.slug), formatWikiFile(file));
  if (!ok) warnings.push(`wiki_write_failed:${file.slug}`);
  return Boolean(ok);
}

function mergeSources(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].slice(0, 20);
}

async function repointLinks(
  storage: DreamStorage,
  scope: string,
  files: Map<string, WikiFile>,
  from: string,
  to: string,
  now: number,
  warnings: string[]
): Promise<void> {
  const needle = `[[${from}]]`;
  for (const [slug, file] of [...files]) {
    if (slug === from || isRetired(file) || !file.body.includes(needle)) continue;
    const updated: WikiFile = {
      ...file,
      body: file.body.split(needle).join(`[[${to}]]`),
      updated: now,
    };
    if (await persistFile(storage, scope, updated, file, now, warnings)) files.set(slug, updated);
  }
}

async function mergeFiles(
  storage: DreamStorage,
  scope: string,
  files: Map<string, WikiFile>,
  from: string,
  to: string,
  now: number,
  warnings: string[]
): Promise<boolean> {
  const source = files.get(from);
  const target = files.get(to);
  if (!source || !target || isRetired(source)) return false;
  const date = new Date(now).toISOString().slice(0, 10);
  const merged: WikiFile = {
    ...target,
    description: target.description || source.description,
    sources: mergeSources(target.sources, source.sources),
    updated: now,
    body: `${target.body}\n\n## Merged from [[${from}]] (${date})\n\n${source.body}`.slice(0, MAX_BODY_CHARS),
  };
  if (!(await persistFile(storage, scope, merged, target, now, warnings))) return false;
  files.set(to, merged);
  await writeStub(storage, scope, source, to, now, files);
  await repointLinks(storage, scope, files, from, to, now, warnings);
  return true;
}

async function writeStub(
  storage: DreamStorage,
  scope: string,
  source: WikiFile,
  movedTo: string,
  now: number,
  files: Map<string, WikiFile>
): Promise<void> {
  const stub: WikiFile = {
    slug: source.slug,
    name: source.name,
    description: `Moved to [[${movedTo}]]`,
    domain: source.domain,
    updated: now,
    sources: source.sources,
    body: `MOVED TO [[${movedTo}]]`,
  };
  await storage.putObject(wikiKey(scope, source.slug), formatWikiFile(stub));
  files.set(source.slug, stub);
}

function capProcessed(processed: DreamState['processed']): DreamState['processed'] {
  const entries = Object.entries(processed).sort((a, b) => b[1].dreamedAt - a[1].dreamedAt);
  return Object.fromEntries(entries.slice(0, MAX_PROCESSED_SESSIONS));
}

/**
 * Runs one dream pass: analyze eligible transcripts, then organize the wiki.
 *
 * Reads/writes only through DreamStorage (memory objects), never deletes raw
 * memory records or sessions. Every overwritten topic keeps a dated history
 * object, and merged topics keep their facts in the merge target.
 */
export async function runDream(
  storage: DreamStorage,
  llm: DreamLlm,
  options: DreamOptions
): Promise<DreamReport> {
  const startedAt = options.now ?? Date.now();
  const scope = safeScope(options.scope);
  const warnings: string[] = [];
  const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  const minIdleMs = Math.max(0, options.minIdleMs ?? DEFAULT_MIN_IDLE_MS);
  const maxFiles = Math.max(10, options.maxFiles ?? DEFAULT_MAX_FILES);
  const timeoutMs = Math.max(5000, options.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS);

  const state = readState(await storage.getObject(stateKey(scope)));
  const indexEntries = await loadWikiIndex(storage, scope);
  const files = await loadFiles(storage, scope, indexEntries, maxFiles, warnings);

  const results: DreamSessionResult[] = [];
  const changedFiles = new Set<string>();
  const merged: Array<{ from: string; to: string }> = [];

  const eligible = options.sessions
    .filter((session) => isDreamEligible(session, startedAt, minIdleMs))
    .sort((a, b) => a.updatedAt - b.updatedAt);

  const candidates = eligible
    .filter((session) => {
      const transcript = formatTranscript(session);
      const previous = state.processed[session.id];
      return !(previous && previous.hash === hashText(transcript));
    })
    .slice(0, maxSessions);

  if (eligible.length > maxSessions) warnings.push('session_limit_reached');

  for (const session of candidates) {
    const transcript = formatTranscript(session);
    const entriesNow = buildIndexEntries([...files.values()]);
    const related = pickRelevantEntries(entriesNow, `${session.title}\n${transcript}`, 3)
      .map((entry) => files.get(entry.slug))
      .filter((file): file is WikiFile => Boolean(file));

    try {
      const analyzed = await withTimeout(
        analyzeSession(llm, {
          session,
          transcript,
          entries: entriesNow,
          related,
          now: startedAt,
        }),
        timeoutMs,
        'analyzer'
      );
      if (analyzed.warning) warnings.push(`analyzer:${session.id}:${analyzed.warning}`);
      if (!analyzed.valid) {
        // A model/JSON failure must stay retryable: do not mark the session done.
        results.push({
          id: session.id,
          title: session.title,
          status: 'failed',
          files: [],
          error: analyzed.warning ?? 'analyzer failed',
        });
        continue;
      }
      if (analyzed.files.length === 0) {
        results.push({ id: session.id, title: session.title, status: 'skipped', files: [] });
        state.processed[session.id] = {
          updatedAt: session.updatedAt,
          hash: hashText(transcript),
          dreamedAt: startedAt,
        };
        continue;
      }

      const written: string[] = [];
      for (const file of analyzed.files) {
        const previous = files.get(file.slug);
        const next: WikiFile = previous
          ? { ...file, sources: mergeSources(previous.sources, file.sources) }
          : file;
        if (await persistFile(storage, scope, next, previous, startedAt, warnings)) {
          files.set(next.slug, next);
          written.push(next.slug);
          changedFiles.add(next.slug);
        }
      }
      state.processed[session.id] = {
        updatedAt: session.updatedAt,
        hash: hashText(transcript),
        dreamedAt: startedAt,
      };
      results.push({
        id: session.id,
        title: session.title,
        status: written.length > 0 ? 'analyzed' : 'failed',
        files: written,
        error: written.length > 0 ? undefined : 'wiki write failed',
      });
    } catch (error) {
      results.push({
        id: session.id,
        title: session.title,
        status: 'failed',
        files: [],
        error: errorText(error),
      });
      warnings.push(`analyzer:${session.id}:${errorText(error)}`);
    }
  }

  if (changedFiles.size > 0) {
    const entriesNow = buildIndexEntries([...files.values()]);
    try {
      const plan = await withTimeout(
        planOrganization(llm, { entries: entriesNow, scope, now: startedAt }),
        timeoutMs,
        'organizer'
      );
      if (plan.warning) warnings.push(`organizer:${plan.warning}`);
      for (const merge of plan.merges) {
        if (await mergeFiles(storage, scope, files, merge.from, merge.to, startedAt, warnings)) {
          merged.push(merge);
          changedFiles.add(merge.to);
          changedFiles.add(merge.from);
        }
      }
      for (const retire of plan.retired) {
        if (merged.some((merge) => merge.from === retire.slug)) continue;
        const source = files.get(retire.slug);
        if (!source || !files.has(retire.movedTo) || isRetired(source)) continue;
        await writeStub(storage, scope, source, retire.movedTo, startedAt, files);
        await repointLinks(storage, scope, files, retire.slug, retire.movedTo, startedAt, warnings);
        merged.push({ from: retire.slug, to: retire.movedTo });
        changedFiles.add(retire.slug);
      }
    } catch (error) {
      warnings.push(`organizer:${errorText(error)}`);
    }
  }

  const loaded = buildIndexEntries([...files.values()]);
  const loadedSlugs = new Set(loaded.map((entry) => entry.slug));
  // Topics beyond the per-run file cap were never read; keep their metadata so
  // the index can never silently shrink.
  const untouched = indexEntries.filter((entry) => !loadedSlugs.has(entry.slug));
  const finalEntries = [...loaded, ...untouched].sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.slug.localeCompare(b.slug)
  );
  const indexFile: WikiIndexFile = { schema: 1, updated: startedAt, entries: finalEntries };
  const indexJson = JSON.stringify(indexFile, null, 2);
  if (!(await storage.putObject(indexJsonKey(scope), indexJson))) warnings.push('index_write_failed');
  if (!(await storage.putObject(indexMarkdownKey(scope), renderIndexMarkdown(finalEntries, scope, startedAt)))) {
    warnings.push('index_markdown_write_failed');
  }

  const prunedHistory = await pruneHistory(storage, scope, startedAt, warnings);
  const finishedAt = Date.now();
  const report: DreamReport = {
    schema: 1,
    startedAt,
    finishedAt,
    scope,
    sessions: results,
    changedFiles: [...changedFiles].sort(),
    merged,
    indexEntries: finalEntries.length,
    prunedHistory,
    warnings,
  };

  const nextState: DreamState = {
    schema: 1,
    processed: capProcessed(state.processed),
    lastRunAt: startedAt,
  };
  if (!(await storage.putObject(stateKey(scope), JSON.stringify(nextState, null, 2)))) {
    report.warnings.push('state_write_failed');
  }
  if (!(await storage.putObject(reportKey(scope), JSON.stringify(report, null, 2)))) {
    report.warnings.push('report_write_failed');
  }
  return report;
}

/**
 * Keeps history bounded: newest version per topic is always kept, older ones
 * are removed beyond 8 versions or after 180 days. No-op when the storage
 * bridge cannot list/delete.
 */
async function pruneHistory(
  storage: DreamStorage,
  scope: string,
  now: number,
  warnings: string[]
): Promise<number> {
  if (!storage.listObjects || !storage.deleteObject) return 0;
  const prefix = `${dreamRoot(scope)}/history/`;
  let keys: string[] = [];
  try {
    keys = (await storage.listObjects(prefix)).filter(
      (key) => key.startsWith(prefix) && key.endsWith('.md')
    );
  } catch {
    warnings.push('history_list_failed');
    return 0;
  }
  const groups = new Map<string, Array<{ key: string; ts: number }>>();
  for (const key of keys.slice(0, 400)) {
    const match = /^(.+)-(\d{10,})\.md$/.exec(key.slice(prefix.length));
    if (!match) continue;
    const list = groups.get(match[1]) ?? [];
    list.push({ key, ts: Number(match[2]) });
    groups.set(match[1], list);
  }
  let pruned = 0;
  for (const list of groups.values()) {
    list.sort((a, b) => b.ts - a.ts);
    for (let index = 1; index < list.length; index += 1) {
      const entry = list[index];
      const tooOld = now - entry.ts > HISTORY_MAX_AGE_MS;
      const tooMany = index >= HISTORY_KEEP_VERSIONS;
      if (!tooOld && !tooMany) continue;
      try {
        if (await storage.deleteObject(entry.key)) pruned += 1;
        else warnings.push('history_delete_failed');
      } catch {
        warnings.push('history_delete_failed');
      }
    }
  }
  return pruned;
}

/** Reads the persisted report so the UI can show the last dream after a restart. */
export async function readLastDream(
  storage: DreamStorage,
  scope: string
): Promise<DreamReport | null> {
  const raw = await storage.getObject(reportKey(scope));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DreamReport;
    if (
      parsed?.schema !== 1 ||
      !Array.isArray(parsed.sessions) ||
      !Array.isArray(parsed.changedFiles) ||
      !Array.isArray(parsed.merged) ||
      !Array.isArray(parsed.warnings) ||
      typeof parsed.startedAt !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export {
  dreamRoot,
  loadWikiContext,
  loadWikiIndex,
  parseWikiFile,
  readIndexJson,
  safeScope,
  sanitizeSlug,
  wikiKey,
} from './wiki';
export type {
  DreamLlm,
  DreamOptions,
  DreamReport,
  DreamSession,
  DreamStorage,
  WikiFile,
  WikiIndexEntry,
} from './types';
