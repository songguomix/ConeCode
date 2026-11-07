// Legacy data migration — safe, verifiable, idempotent, non-destructive.
//
// The old data is NEVER deleted or rewritten. We read <userData>/data/memory.json
// plus the CLAUDE.md / AGENTS.md files (through the Electron bridge), back the
// original up, map every usable item into Memory 2.0, verify that nothing was
// lost, and only then mark the migration done. Anything that cannot be
// classified lands in a "needs triage" area with status=pending.
//
// Project isolation is enforced here too: a project-scoped legacy entry whose
// stored path belongs to a different workspace is left untouched in the old
// store. Opening that workspace later runs its own migration pass.

import type { Memory2State, MemoryRecord, MigrationReport } from './types';
import { createRecord, hashString, looksLikeSecret } from './model';
import type { MemoryType } from './types';

export interface LegacyEntry {
  id?: string;
  kind?: string;
  text?: string;
  why?: string;
  scope?: string;
  projectPath?: string;
  createdAt?: number;
  updatedAt?: number;
  hits?: number;
}

export interface LegacyFile {
  path: string;
  scope: 'user' | 'project' | 'ancestor';
  content: string;
}

export interface MigrationInput {
  entries: LegacyEntry[];
  files: LegacyFile[];
  projectId: string | null;
  /** Absolute workspace path, used to reject another project's legacy rows. */
  projectRootPath?: string | null;
  now: number;
  makeId: () => string;
  deviceId: string;
  sessionId: string;
  backupPath?: string | null;
}

export interface MigrationPlan {
  records: MemoryRecord[];
  report: MigrationReport;
  /** Source texts that could not be mapped with confidence. */
  unclassified: string[];
}

const KIND_MAP: Record<string, { type: MemoryType; layer: 'global' | 'project' }> = {
  workflow: { type: 'constraint', layer: 'global' },
  project: { type: 'project_fact', layer: 'project' },
  codeIssue: { type: 'known_bug', layer: 'project' },
  style: { type: 'user_fact', layer: 'global' },
  fact: { type: 'user_fact', layer: 'global' },
  preference: { type: 'constraint', layer: 'global' },
};

function normalizeRoot(value: string | null | undefined): string {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** A stable fingerprint of the source *for this project*, so it is never run twice. */
export function migrationSourceHash(input: MigrationInput): string {
  const payload = JSON.stringify({
    projectId: input.projectId,
    entries: input.entries.map((e) => [e.id, e.text, e.kind, e.scope, normalizeRoot(e.projectPath)]),
    files: input.files.map((f) => [f.path, f.content]),
  });
  return hashString(payload);
}

export function isMigrationApplied(state: Memory2State, sourceHash: string): boolean {
  return state.migration.sourceHashes.includes(sourceHash);
}

/** Deterministic id: re-running migration (or opening another project) cannot duplicate a row. */
function migrationId(text: string, type: string, layer: string, projectId: string | null): string {
  return `mem-mig-${hashString(JSON.stringify([text, type, layer, projectId]))}`;
}

type EntryMapping =
  | { kind: 'record'; record: MemoryRecord }
  | { kind: 'other-project' }
  | { kind: 'no-project' }
  | { kind: 'skip' };

function legacyToRecord(entry: LegacyEntry, input: MigrationInput): EntryMapping {
  const text = (entry.text ?? '').trim();
  if (!text || looksLikeSecret(text)) return { kind: 'skip' };

  const mapping = KIND_MAP[entry.kind ?? 'fact'] ?? KIND_MAP.fact;
  const isProject = entry.scope === 'project' || mapping.layer === 'project';

  // Never import another workspace's project facts into this one.
  if (isProject && entry.projectPath) {
    const sourceRoot = normalizeRoot(entry.projectPath);
    const currentRoot = normalizeRoot(input.projectRootPath);
    if (currentRoot && sourceRoot && sourceRoot !== currentRoot) return { kind: 'other-project' };
  }
  if (isProject && !input.projectId) return { kind: 'no-project' };

  const layer = isProject ? 'project' : 'global';
  const projectId = layer === 'global' ? null : input.projectId;
  const id = migrationId(text, mapping.type, layer, projectId);
  const record = createRecord({
    title: text.slice(0, 90),
    content: text,
    type: mapping.type,
    layer,
    projectId,
    tags: ['migrated', `legacy:${entry.kind ?? 'fact'}`],
    importance: Math.min(1, 0.5 + Math.min(5, entry.hits ?? 1) * 0.06),
    // AI-inferred legacy entries are NOT upgraded to confirmed facts.
    confidence: 0.65,
    status: 'inferred',
    origin: 'migration',
    why: entry.why?.trim() || undefined,
    sourceSessionId: input.sessionId,
    sourceEventId: entry.id,
  }, {
    id,
    deviceId: input.deviceId,
    now: Number.isFinite(entry.createdAt) ? entry.createdAt! : input.now,
  });
  record.updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt! : input.now;
  return { kind: 'record', record };
}

function classifyFileLine(text: string): MemoryType | null {
  if (/(always|never|must|prefer|use |do not|don't|务必|不要|总是|使用|遵循|禁止)/i.test(text)) return 'constraint';
  if (/(bug|error|issue|问题|缺陷|失败)/i.test(text)) return 'known_bug';
  if (/(架构|architecture|module|模块|stack|技术栈)/i.test(text)) return 'architecture';
  return text.length >= 20 ? 'project_fact' : null;
}

function fileLinesToRecords(
  file: LegacyFile,
  input: MigrationInput,
): { records: MemoryRecord[]; unclassified: string[]; skippedNoProject: number } {
  const records: MemoryRecord[] = [];
  const unclassified: string[] = [];
  let skippedNoProject = 0;
  const global = file.scope === 'user';
  if (!global && !input.projectId) return { records, unclassified, skippedNoProject: 1 };

  let inFence = false;
  for (const raw of file.content.split('\n')) {
    const line = raw.trim();
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence || !line) continue;
    if (/^#{1,6}\s/.test(line)) continue;                 // headings are structure, not facts
    const text = line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim();
    if (text.length < 8 || looksLikeSecret(text)) continue;
    if (/^<!--/.test(text)) continue;
    const type = classifyFileLine(text);
    if (!type) unclassified.push(text);
    const layer = global ? 'global' : 'project';
    const projectId = global ? null : input.projectId;
    const record = createRecord({
      title: text.slice(0, 90),
      content: text,
      type: type ?? 'project_fact',
      layer,
      projectId,
      tags: ['migrated', `file:${file.scope}`, ...(type ? [] : ['needs-triage'])],
      importance: 0.6,
      confidence: 0.9,          // the human wrote it down on purpose
      status: type ? 'confirmed' : 'pending',
      origin: 'migration',
      needsTriage: !type,
      sourceSessionId: input.sessionId,
      sourceEventId: hashString(`${file.path}:${text}`),
    }, {
      id: migrationId(text, type ?? 'project_fact', layer, projectId),
      deviceId: input.deviceId,
      now: input.now,
    });
    records.push(record);
  }
  return { records, unclassified, skippedNoProject };
}

/** Text that validation must find in the new corpus, mirroring what planMigration imports. */
function expectedEntryTexts(input: MigrationInput): string[] {
  const out: string[] = [];
  for (const entry of input.entries) {
    const mapping = KIND_MAP[entry.kind ?? 'fact'] ?? KIND_MAP.fact;
    const isProject = entry.scope === 'project' || mapping.layer === 'project';
    const text = (entry.text ?? '').trim();
    if (!text || looksLikeSecret(text)) continue;
    if (isProject && !input.projectId) continue;
    if (isProject && entry.projectPath) {
      const sourceRoot = normalizeRoot(entry.projectPath);
      const currentRoot = normalizeRoot(input.projectRootPath);
      if (currentRoot && sourceRoot && sourceRoot !== currentRoot) continue;
    }
    out.push(text);
  }
  return out;
}

function expectedFileTexts(input: MigrationInput): string[] {
  const out: string[] = [];
  for (const file of input.files) {
    if (file.scope !== 'user' && !input.projectId) continue;
    let inFence = false;
    for (const raw of file.content.split('\n')) {
      const line = raw.trim();
      if (/^```/.test(line)) { inFence = !inFence; continue; }
      if (inFence || !line || /^#{1,6}\s/.test(line) || /^<!--/.test(line)) continue;
      const text = line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim();
      if (text.length < 8 || looksLikeSecret(text)) continue;
      out.push(text);
    }
  }
  return out;
}

export function planMigration(input: MigrationInput): MigrationPlan {
  const records: MemoryRecord[] = [];
  const unclassified: string[] = [];
  let skippedDuplicates = 0;
  let skippedOtherProject = 0;
  let skippedNoProject = 0;
  const seen = new Set<string>();

  const add = (record: MemoryRecord) => {
    const key = `${record.layer}:${record.projectId ?? ''}:${record.content.toLowerCase()}`;
    if (seen.has(key)) { skippedDuplicates++; return; }
    seen.add(key);
    records.push(record);
  };

  for (const entry of input.entries) {
    const mapped = legacyToRecord(entry, input);
    if (mapped.kind === 'record') add(mapped.record);
    else if (mapped.kind === 'other-project') skippedOtherProject++;
    else if (mapped.kind === 'no-project') skippedNoProject++;
  }
  for (const file of input.files) {
    const result = fileLinesToRecords(file, input);
    result.records.forEach(add);
    unclassified.push(...result.unclassified);
    skippedNoProject += result.skippedNoProject;
  }

  const sourceHash = migrationSourceHash(input);
  const report: MigrationReport = {
    legacyEntries: input.entries.length,
    fileLines: input.files.reduce((n, f) => n + f.content.split('\n').filter((l) => l.trim()).length, 0),
    imported: records.length,
    skippedDuplicates,
    skippedOtherProject,
    skippedNoProject,
    needsTriage: unclassified.length,
    sourceHash,
    backupPath: input.backupPath ?? null,
    verified: false,
    at: input.now,
  };
  return { records, report, unclassified };
}

/**
 * Verify completeness BEFORE anything is cleaned up. Every non-secret legacy
 * text that should be imported must be present in the new records; otherwise
 * the migration is rejected. Other projects' rows are intentionally excluded.
 */
export function validateMigration(
  plan: MigrationPlan,
  input: MigrationInput,
): { ok: boolean; missing: string[]; report: MigrationReport } {
  const corpus = plan.records.map((r) => r.content.toLowerCase()).join('\n');
  const missing: string[] = [];
  const expected = [...expectedEntryTexts(input), ...expectedFileTexts(input)];
  for (const text of expected) {
    if (!corpus.includes(text.toLowerCase().slice(0, 60))) missing.push(text.slice(0, 80));
  }
  const ok = missing.length === 0;
  return { ok, missing, report: { ...plan.report, verified: ok } };
}

/** Apply a verified plan to state. Idempotent and additive — nothing is removed. */
export function applyMigration(state: Memory2State, plan: MigrationPlan): Memory2State {
  const ids = new Set(state.records.map((r) => r.id));
  const contentKeys = new Set(state.records
    .filter((r) => r.deletedAt === null)
    .map((r) => `${r.layer}:${r.projectId ?? ''}:${r.content.toLowerCase()}`));
  const fresh = plan.records.filter((r) => {
    if (ids.has(r.id)) return false;
    const key = `${r.layer}:${r.projectId ?? ''}:${r.content.toLowerCase()}`;
    if (contentKeys.has(key)) return false;
    ids.add(r.id);
    contentKeys.add(key);
    return true;
  });
  const report = { ...plan.report, imported: fresh.length };
  return {
    ...state,
    records: [...state.records, ...fresh],
    migration: {
      legacyDone: true,
      filesDone: true,
      sourceHashes: Array.from(new Set([...state.migration.sourceHashes, report.sourceHash])),
      at: report.at,
      report,
    },
  };
}

/** Human-readable Markdown export (also used as an object-storage backup). */
export function toMarkdown(records: MemoryRecord[]): string {
  const groups = new Map<string, MemoryRecord[]>();
  for (const r of records) {
    if (r.deletedAt !== null) continue;
    const key = r.layer === 'global' ? 'Global' : `Project ${r.projectId ?? 'unknown'}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out = ['# ConeCode Memory 2.0 export', '', `Generated: ${new Date().toISOString()}`, ''];
  for (const [group, items] of groups) {
    out.push(`## ${group}`, '');
    for (const r of items.sort((a, b) => b.importance - a.importance)) {
      out.push(`### ${r.title}`);
      out.push(`- type: ${r.type} · status: ${r.status} · importance: ${r.importance.toFixed(2)} · confidence: ${r.confidence.toFixed(2)}`);
      out.push(`- tags: ${r.tags.join(', ') || '—'} · v${r.version} · updated: ${new Date(r.updatedAt).toISOString()}`);
      if (r.why) out.push(`- reason: ${r.why}`);
      if (r.sourceSessionId) out.push(`- source session: ${r.sourceSessionId}`);
      out.push('', r.content, '');
    }
  }
  return out.join('\n');
}
