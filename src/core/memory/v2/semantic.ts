// Semantic retrieval extension point.
//
// Honest scope: this project has no embedding model and no vector database.
// Full-text (BM25, CJK-aware) is the reliable baseline. A real embedding
// provider can be plugged in via setSemanticProvider() without touching the
// engine; the default implementation is explicitly *lexical*, not neural, and
// says so in its `label`. We do not pretend a hash vector is semantics.

import type { MemoryRecord } from './types';
import { termSet, jaccard } from './text';

export interface SemanticProvider {
  /** Human-readable label shown in the UI. */
  readonly label: string;
  /** False for the lexical fallback — the UI must not claim "vector search". */
  readonly isSemantic: boolean;
  similarity(a: string, b: string): Promise<number>;
}

/** Deterministic token-overlap similarity. Good enough to order near-misses. */
export const lexicalSemanticProvider: SemanticProvider = {
  label: 'lexical overlap (no embedding model configured)',
  isSemantic: false,
  async similarity(a, b) {
    return jaccard(termSet(a), termSet(b));
  },
};

let provider: SemanticProvider = lexicalSemanticProvider;

export function setSemanticProvider(next: SemanticProvider): void { provider = next; }
export function getSemanticProvider(): SemanticProvider { return provider; }

export interface SemanticHit { record: MemoryRecord; similarity: number }

/** Optional semantic re-ranking. `isSemantic === false` -> returns [] so callers never misreport. */
export async function semanticSearch(
  records: MemoryRecord[],
  query: string,
  opts: { min?: number; limit?: number } = {},
): Promise<SemanticHit[]> {
  if (!provider.isSemantic) return [];
  const min = opts.min ?? 0.35;
  const scored = await Promise.all(records.map(async (record) => ({
    record,
    similarity: await provider.similarity(query, `${record.title} ${record.content}`),
  })));
  return scored
    .filter((h) => h.similarity >= min)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, opts.limit ?? 20);
}
