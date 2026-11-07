// Memory relationship graph.
//
// A memory about "network module" is far more useful if retrieval can also find
// its historical bugs, the decision that introduced it and the lesson learned
// from fixing it. Relations are explicit edges; expansion is a bounded BFS.

import type { MemoryRecord, RelationKind } from './types';

const INVERSE: Record<RelationKind, RelationKind> = {
  related: 'related',
  supersedes: 'derived_from',
  derived_from: 'related',
  caused_by: 'solves',
  solves: 'caused_by',
  part_of: 'related',
  conflicts_with: 'conflicts_with',
};

export interface LinkContext { now: number; deviceId: string }

/** Add an edge to both records. Returns new records (immutably). */
export function linkMemories(
  a: MemoryRecord,
  b: MemoryRecord,
  kind: RelationKind,
  ctx: LinkContext,
  note?: string,
): [MemoryRecord, MemoryRecord] {
  if (a.id === b.id) return [a, b];
  const withEdge = (from: MemoryRecord, to: MemoryRecord, k: RelationKind): MemoryRecord => {
    const relations = from.relations.some((r) => r.targetId === to.id && r.kind === k)
      ? from.relations
      : [...from.relations, { targetId: to.id, kind: k, note }];
    return {
      ...from,
      relations,
      relatedMemoryIds: Array.from(new Set([...from.relatedMemoryIds, to.id])),
      version: from.relations === relations && from.relatedMemoryIds.includes(to.id) ? from.version : from.version + 1,
      updatedAt: ctx.now,
      deviceId: ctx.deviceId,
      syncStatus: 'local',
    };
  };
  return [withEdge(a, b, kind), withEdge(b, a, INVERSE[kind])];
}

export function unlinkMemories(a: MemoryRecord, b: MemoryRecord, ctx: LinkContext): [MemoryRecord, MemoryRecord] {
  const without = (from: MemoryRecord, to: MemoryRecord): MemoryRecord => ({
    ...from,
    relations: from.relations.filter((r) => r.targetId !== to.id),
    relatedMemoryIds: from.relatedMemoryIds.filter((id) => id !== to.id),
    updatedAt: ctx.now,
    deviceId: ctx.deviceId,
    version: from.version + 1,
    syncStatus: 'local',
  });
  return [without(a, b), without(b, a)];
}

export interface RelatedHit {
  record: MemoryRecord;
  depth: number;
  /** Decays with distance; direct edges are worth more than transitive ones. */
  weight: number;
  via: string[];
}

/**
 * Bounded breadth-first expansion from a set of seeds. Cycle-safe and capped,
 * so one heavily-linked memory cannot flood the Agent's context.
 */
export function expandRelated(
  all: MemoryRecord[],
  seeds: MemoryRecord[],
  opts: { depth?: number; max?: number; projectId?: string | null } = {},
): RelatedHit[] {
  const maxDepth = Math.max(1, Math.min(3, opts.depth ?? 2));
  const cap = Math.max(1, opts.max ?? 20);
  const byId = new Map(all.map((r) => [r.id, r]));
  const seedIds = new Set(seeds.map((s) => s.id));
  const visited = new Set(seedIds);
  const out: RelatedHit[] = [];
  let frontier = seeds.map((s) => ({ record: s, depth: 0, via: [] as string[] }));

  for (let d = 1; d <= maxDepth && out.length < cap; d++) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      const edges = new Set([
        ...node.record.relatedMemoryIds,
        ...node.record.relations.map((r) => r.targetId),
      ]);
      for (const id of edges) {
        if (visited.has(id)) continue;
        const target = byId.get(id);
        if (!target || target.deletedAt !== null) continue;
        // Never cross the project boundary through a relation.
        if (opts.projectId !== undefined && target.layer !== 'global' && target.projectId !== opts.projectId) continue;
        visited.add(id);
        const hit: RelatedHit = {
          record: target,
          depth: d,
          weight: 1 / d,
          via: [...node.via, id],
        };
        out.push(hit);
        if (out.length >= cap) break;
        next.push({ record: target, depth: d, via: hit.via });
      }
      if (out.length >= cap) break;
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return out;
}
