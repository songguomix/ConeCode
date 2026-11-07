// Memory lifecycle: supplement, correct, merge, supersede, archive, version, undo.
//
// The legacy system could only append and delete. Every operation here keeps a
// version snapshot so a wrong correction is reversible and so two devices can
// be compared against a common base.

import type { MemoryRecord, MemoryStatus, MemoryVersion } from './types';
import { assertMutable, contentHashOf, PROTECTED_IMPORTANCE, snapshot } from './model';
import type { ClassifiedMemory } from './classify';
import { isContained } from './text';

export interface MutationContext {
  now: number;
  deviceId: string;
  reason: string;
  force?: boolean;
}

export interface MemoryPatch {
  title?: string;
  content?: string;
  type?: MemoryRecord['type'];
  layer?: MemoryRecord['layer'];
  projectId?: string | null;
  tags?: string[];
  importance?: number;
  confidence?: number;
  status?: MemoryStatus;
  why?: string;
  needsTriage?: boolean;
  /** Explicit human confirmation for overwriting a protected memory. */
  force?: boolean;
}

/** Keep enough history for undo/audit without letting a hot record grow forever. */
export const MAX_HISTORY = 50;

function nextVersion(record: MemoryRecord, ctx: MutationContext): MemoryRecord {
  return {
    ...record,
    version: record.version + 1,
    updatedAt: ctx.now,
    deviceId: ctx.deviceId,
    syncStatus: 'local',
    history: [...record.history, snapshot(record, ctx.reason)].slice(-MAX_HISTORY),
  };
}

function rehash(record: MemoryRecord): MemoryRecord {
  return { ...record, contentHash: contentHashOf(record) };
}

/** Every write goes through here so version/hash/timestamp stay consistent. */
export function updateMemory(record: MemoryRecord, patch: MemoryPatch, ctx: MutationContext): MemoryRecord {
  assertMutable(record, 'overwrite', ctx.force);
  // Snapshot the record BEFORE the patch is applied. Snapshotting the merged
  // object would make "undo" restore the value that was just written.
  const versioned = nextVersion(record, ctx);
  const merged: MemoryRecord = {
    ...versioned,
    ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 160) } : {}),
    ...(patch.content !== undefined ? { content: patch.content.trim() } : {}),
    ...(patch.type !== undefined ? { type: patch.type } : {}),
    ...(patch.layer !== undefined ? { layer: patch.layer } : {}),
    ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
    ...(patch.tags !== undefined ? { tags: Array.from(new Set(patch.tags.map((t) => t.trim()).filter(Boolean))) } : {}),
    ...(patch.importance !== undefined ? { importance: Math.max(0, Math.min(1, patch.importance)) } : {}),
    ...(patch.confidence !== undefined ? { confidence: Math.max(0, Math.min(1, patch.confidence)) } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.why !== undefined ? { why: patch.why.trim() || undefined } : {}),
    ...(patch.needsTriage !== undefined ? { needsTriage: patch.needsTriage } : {}),
  };
  if (merged.layer === 'global') merged.projectId = null;
  if (merged.layer !== 'global' && !merged.projectId) {
    throw new Error('cannot move a memory out of project scope without a projectId');
  }
  return rehash(merged);
}

/** Re-observing the same fact raises its weight without creating a duplicate. */
export function reinforce(record: MemoryRecord, ctx: MutationContext, sharper?: string): MemoryRecord {
  // A protected memory is already at the top of the importance range. Do not
  // make a harmless re-observation fail the whole extraction just because the
  // overwrite guard is doing its job.
  if (record.importance >= PROTECTED_IMPORTANCE) return record;
  return updateMemory(record, {
    importance: Math.min(1, record.importance + 0.06),
    ...(sharper && sharper.length > record.content.length ? { content: sharper } : {}),
  }, { ...ctx, reason: 're-observed (reinforced)' });
}

/** Merge two records about the same subject; keeps the union, never loses detail. */
export function mergeMemories(primary: MemoryRecord, secondary: MemoryRecord, ctx: MutationContext): MemoryRecord {
  const content = primary.content.length >= secondary.content.length
    ? (secondary.content.includes(primary.content) ? secondary.content : `${primary.content}\n${secondary.content}`.slice(0, 4000))
    : (primary.content.includes(secondary.content) ? primary.content : `${secondary.content}\n${primary.content}`.slice(0, 4000));
  const merged = updateMemory(primary, {
    content,
    tags: Array.from(new Set([...primary.tags, ...secondary.tags])),
    importance: Math.max(primary.importance, secondary.importance),
    confidence: Math.max(primary.confidence, secondary.confidence),
    why: primary.why || secondary.why,
  }, ctx);
  return {
    ...merged,
    relatedMemoryIds: Array.from(new Set([...merged.relatedMemoryIds, secondary.id])),
    relations: [...merged.relations, { targetId: secondary.id, kind: 'part_of', note: 'merged duplicate' }],
  };
}

/**
 * New information replaces an old memory only after judging source, time and
 * confidence. When the winner is not clear we keep BOTH versions and link them,
 * instead of destroying the older one.
 */
export function reconcile(
  existing: MemoryRecord,
  incoming: ClassifiedMemory,
  ctx: MutationContext & { incomingAt?: number; incomingSource?: string },
): { record: MemoryRecord; outcome: 'superseded' | 'updated' | 'kept_both' } {
  const newer = ctx.incomingAt ?? ctx.now;
  // Protected memories are never silently corrected by extraction; keep both
  // and let the human confirm the overwrite in the UI.
  if (existing.importance >= PROTECTED_IMPORTANCE && !ctx.force) {
    return { record: existing, outcome: 'kept_both' };
  }
  const incomingIsUserStated = incoming.status === 'confirmed' && incoming.confidence >= 0.9;
  const existingIsUserStated = existing.origin === 'user' && existing.confidence >= 0.9;

  // A confirmed user statement always wins over an earlier inference.
  const decisive = incomingIsUserStated && !existingIsUserStated;
  // An inference never silently overwrites an explicit user fact.
  const blocked = !incomingIsUserStated && existingIsUserStated;
  // "X lives in A" and "X lives in B" are a genuine disagreement even when
  // neither side is more confident. Keep both rather than picking a winner.
  const materiallyDifferent = !isContained(incoming.content, existing.content)
    && !isContained(existing.content, incoming.content);

  if (blocked || (newer <= existing.updatedAt && !decisive)) {
    return { record: existing, outcome: 'kept_both' };
  }

  if (decisive || incoming.confidence >= existing.confidence + 0.2) {
    // The old content survives in history; the relation is added by the caller
    // when it wants a visible conflict edge.
    const updated = updateMemory(existing, {
      content: incoming.content,
      title: incoming.title,
      type: incoming.type,
      tags: incoming.tags,
      importance: Math.max(existing.importance, incoming.importance),
      confidence: incoming.confidence,
      status: incoming.status,
      why: incoming.why,
    }, { ...ctx, reason: 'corrected by newer information' });
    return { record: updated, outcome: 'superseded' };
  }
  if (materiallyDifferent) return { record: existing, outcome: 'kept_both' };
  return { record: updateMemory(existing, { why: incoming.why ?? existing.why }, { ...ctx, reason: 'supplemented' }), outcome: 'updated' };
}

export function supersede(old: MemoryRecord, replacementId: string, ctx: MutationContext): MemoryRecord {
  return updateMemory(old, { status: 'superseded' }, { ...ctx, reason: `superseded by ${replacementId}` });
}

export function archiveMemory(record: MemoryRecord, ctx: MutationContext & { force?: boolean }): MemoryRecord {
  return updateMemory(record, { status: 'archived' }, { ...ctx, reason: ctx.reason || 'archived by user' });
}

/** Soft delete: a tombstone that syncs, so the record never reappears on another device. */
export function tombstone(record: MemoryRecord, ctx: MutationContext & { force?: boolean }): MemoryRecord {
  assertMutable(record, 'delete', ctx.force);
  const archived = nextVersion(record, ctx);
  return { ...archived, deletedAt: ctx.now, status: 'archived', syncStatus: 'local' };
}

/** Restore the immediately preceding version. Undo is itself versioned. */
export function undoUpdate(record: MemoryRecord, ctx: MutationContext): MemoryRecord {
  const previous = record.history[record.history.length - 1];
  if (!previous) throw new Error('no earlier version to restore');
  const restored = updateMemory(record, {
    title: previous.title,
    content: previous.content,
    type: previous.type,
    layer: previous.layer,
    status: previous.status,
    importance: previous.importance,
    confidence: previous.confidence,
    tags: previous.tags,
    why: previous.why,
  }, { ...ctx, reason: `undo to v${previous.version}` });
  return restored;
}

export function getHistory(record: MemoryRecord): MemoryVersion[] {
  return [...record.history, snapshot(record, 'current')];
}

/** Working memory expires; valuable items are promoted instead of being dropped. */
export function isWorkingMemoryExpired(record: MemoryRecord, ttl: number, now: number): boolean {
  return record.layer === 'working' && now - record.updatedAt > ttl;
}
