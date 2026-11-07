// Memory 2.0 — active retrieval.
//
// The legacy "retrieval" was: take every memory, group by kind, paste into the
// system prompt. Here retrieval is a real ranked query with BM25 full-text,
// metadata filters, relation expansion, hybrid merge and mandatory provenance.
// Full-text is the reliable baseline; semantic search is an optional provider.

import type { MemoryQuery, MemoryRecord, SearchHit, StorageKind } from './types';
import { visibleToProject } from './model';
import { tokenize } from './text';
import { expandRelated } from './relations';

const K1 = 1.5;
const B = 0.75;

interface IndexedDoc {
  record: MemoryRecord;
  terms: string[];
  length: number;
}
interface FtIndex {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLength: number;
  size: number;
}

/** Build a small in-memory inverted-ish index. Cheap enough to rebuild on writes. */
export function buildIndex(records: MemoryRecord[]): FtIndex {
  const docs = records.map((record) => {
    // Field repetition is the boost: title/tags count more than body text.
    const terms = [
      ...tokenize(record.title), ...tokenize(record.title),
      ...tokenize(record.tags.join(' ')), ...tokenize(record.tags.join(' ')),
      ...tokenize(record.content),
      ...tokenize(record.why ?? ''),
    ];
    return { record, terms, length: terms.length };
  });
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.terms)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const total = docs.reduce((n, d) => n + d.length, 0);
  return { docs, df, avgLength: docs.length ? total / docs.length : 0, size: docs.length };
}

function bm25(index: FtIndex, doc: IndexedDoc, queryTerms: string[]): { score: number; matched: string[] } {
  if (!queryTerms.length || !doc.length) return { score: 0, matched: [] };
  const tf = new Map<string, number>();
  for (const t of doc.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  const matched: string[] = [];
  for (const term of new Set(queryTerms)) {
    const freq = tf.get(term);
    if (!freq) continue;
    matched.push(term);
    const n = index.df.get(term) ?? 0;
    const idf = Math.log(1 + (index.size - n + 0.5) / (n + 0.5));
    score += idf * (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * doc.length / (index.avgLength || 1)));
  }
  return { score, matched };
}

/** Recency in [0,1] with a ~90-day half-life. Older isn't worthless, just softer. */
export function recencyScore(updatedAt: number, now: number): number {
  const ageDays = Math.max(0, (now - updatedAt) / 86_400_000);
  return 1 / (1 + ageDays / 90);
}

export function rankScore(hit: { score: number; record: MemoryRecord }, now: number): number {
  const r = hit.record;
  return (
    Math.min(1, hit.score / 6) * 0.55 +
    r.importance * 0.2 +
    r.confidence * 0.12 +
    recencyScore(r.updatedAt, now) * 0.08 +
    (r.status === 'confirmed' ? 0.05 : 0)
  );
}

function passesFilters(r: MemoryRecord, q: MemoryQuery): boolean {
  if (!q.includeDeleted && r.deletedAt !== null) return false;
  if (!q.statuses?.length && (r.status === 'archived' || r.status === 'superseded')) return false;
  if (q.layers?.length && !q.layers.includes(r.layer)) return false;
  if (q.types?.length && !q.types.includes(r.type)) return false;
  if (q.statuses?.length && !q.statuses.includes(r.status)) return false;
  if (q.tags?.length && !q.tags.some((t) => r.tags.includes(t))) return false;
  if (q.importanceMin !== undefined && r.importance < q.importanceMin) return false;
  if (q.confidenceMin !== undefined && r.confidence < q.confidenceMin) return false;
  if (q.from !== undefined && r.updatedAt < q.from) return false;
  if (q.to !== undefined && r.updatedAt > q.to) return false;
  if (q.sourceSessionId && r.sourceSessionId !== q.sourceSessionId) return false;
  return true;
}

/** Apply scope + hard project isolation. This is the only gate on project data. */
function inScope(r: MemoryRecord, q: MemoryQuery): boolean {
  const scope = q.scope ?? 'all';
  if (scope === 'global') return r.layer === 'global';
  if (scope === 'project') return !!q.projectId && r.projectId === q.projectId;
  // 'all' / 'local' / 'cloud' still never expose another project's records.
  return visibleToProject(r, q.projectId ?? null);
}

/** Deterministic local search. `source` is stamped by the caller's provider. */
export function searchRecords(
  records: MemoryRecord[],
  query: MemoryQuery,
  opts: { now?: number; source?: StorageKind; index?: FtIndex } = {},
): SearchHit[] {
  const now = opts.now ?? Date.now();
  const source = opts.source ?? 'local';
  const pool = records.filter((r) => inScope(r, query) && passesFilters(r, query));
  const browsing = !query.text.trim();
  const queryTerms = tokenize(query.text);
  const index = opts.index ?? buildIndex(pool);
  // If a shared index was supplied it may contain excluded docs; filter by id.
  const allowed = new Set(pool.map((r) => r.id));

  let hits: SearchHit[] = index.docs
    .filter((d) => allowed.has(d.record.id))
    .map((doc) => {
      const { score, matched } = bm25(index, doc, queryTerms);
      const reasons: string[] = [];
      if (matched.length) reasons.push(`full-text: ${matched.slice(0, 4).join(', ')}`);
      if (doc.record.status === 'confirmed') reasons.push('user-confirmed');
      if (doc.record.importance >= 0.8) reasons.push('high importance');
      return { record: doc.record, score, source, matchedTerms: matched, reasons };
    })
    .filter((h) => browsing || h.score > 0);

  // No query text: browse mode, still ranked by importance/confidence/recency.
  // A non-empty query that tokenizes to nothing (pure punctuation) must NOT
  // become a browse request — that would dump unrelated memory into the prompt.
  if (browsing) {
    hits = pool.map((record) => ({
      record, score: 0, source, matchedTerms: [], reasons: ['browse'],
    }));
  }

  hits.sort((a, b) => rankScore(b, now) - rankScore(a, now));

  if (query.includeRelated && hits.length) {
    const seeds = hits.slice(0, 5).map((h) => h.record);
    const related = expandRelated(records, seeds, {
      depth: query.relatedDepth ?? 1,
      max: 12,
      projectId: query.projectId ?? null,
    });
    const present = new Set(hits.map((h) => h.record.id));
    for (const rel of related) {
      if (present.has(rel.record.id) || !inScope(rel.record, query) || !passesFilters(rel.record, query)) continue;
      hits.push({
        record: rel.record,
        score: hits[0].score * rel.weight * 0.35,
        source,
        matchedTerms: [],
        reasons: [`related via ${rel.via[0] ?? 'graph'} (depth ${rel.depth})`],
      });
      present.add(rel.record.id);
    }
  }
  return hits.slice(0, query.limit ?? 30);
}

/**
 * Merge local + cloud results. Same UUID -> keep the newer version / better
 * score, but never lose the provenance label. Cloud results carry their own
 * projectId/version and are re-checked against scope here.
 */
export function mergeHybrid(
  local: SearchHit[],
  cloud: SearchHit[],
  query: MemoryQuery,
  opts: { now?: number } = {},
): SearchHit[] {
  const now = opts.now ?? Date.now();
  const byId = new Map<string, SearchHit>();
  for (const hit of [...local, ...cloud]) {
    if (!inScope(hit.record, query)) continue;
    const existing = byId.get(hit.record.id);
    if (!existing) { byId.set(hit.record.id, hit); continue; }
    const newer = hit.record.version > existing.record.version;
    const better = hit.score > existing.score;
    const keep = newer || (!newer && hit.record.version === existing.record.version && better);
    if (keep) {
      byId.set(hit.record.id, {
        ...hit,
        reasons: Array.from(new Set([...existing.reasons, ...hit.reasons, `merged local+cloud (v${hit.record.version})`])),
        source: hit.source,
      });
    } else {
      existing.reasons.push('duplicate result from another source');
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => rankScore(b, now) - rankScore(a, now))
    .slice(0, query.limit ?? 30);
}

/**
 * Compact prompt injection. Never dump the whole store: top hits only, capped
 * by characters, each labelled with source/version/status so the model can
 * weigh an inference against a confirmed fact.
 */
export function formatRetrievalBlock(hits: SearchHit[], maxChars = 6000): string {
  const usable = hits.filter((h) => h.record.deletedAt === null && h.record.status !== 'archived');
  if (!usable.length) return '';
  const lines: string[] = [
    'RELEVANT LONG-TERM MEMORY (retrieved for this task, not a chat summary).',
    'Use it silently. A memory marked "inferred" is an agent conclusion — verify before relying on it. If the user contradicts a memory, the user wins.',
  ];
  let used = lines.join('\n').length;
  for (const hit of usable) {
    const r = hit.record;
    const meta = `[${r.layer}/${r.type} | ${r.status} | v${r.version} | ${hit.source} | importance ${r.importance.toFixed(2)}]`;
    const source = r.sourceSessionId ? ` | session ${r.sourceSessionId.slice(0, 8)}` : '';
    const why = r.why ? `\n  reason: ${r.why.slice(0, 300)}` : '';
    const line = `- ${meta}${source}\n  ${r.title}: ${r.content.slice(0, 900)}${why}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 2 ? lines.join('\n') : '';
}

/** Task-start decision: does this task need history at all? */
export function needsHistory(taskText: string): boolean {
  if (!taskText.trim()) return false;
  // Pure acknowledgements and greetings do not warrant a retrieval round.
  return !/^(ok|okay|thanks|thank you|好的|谢谢|收到|嗯|继续|hi|hello|你好|您好|嗨|在吗|早上好|晚上好)[\s\W!！.。~]*$/i.test(taskText.trim());
}
