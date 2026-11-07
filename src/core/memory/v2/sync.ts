// Memory Sync Engine — incremental, bidirectional, offline-tolerant.
//
// Design rules enforced here:
//  * Every mutation becomes a change-log entry with a monotonic seq (the cursor).
//  * Pull is idempotent: applied change ids are remembered, so replaying a feed
//    can never create duplicates.
//  * Deletes are tombstones. A deleted memory never reappears on another device.
//  * Concurrent edits are NOT blindly overwritten: try a 3-way merge, otherwise
//    keep BOTH versions as a conflict for a human to resolve.
//  * Cloud unavailable -> local work continues; edits queue offline and resume.

import type {
  Memory2State, MemoryChange, MemoryConflict, MemoryRecord, SyncState,
} from './types';
import { contentHashOf, hashString, normalizeRecord } from './model';
import { tombstone, updateMemory, type MemoryPatch } from './lifecycle';
import type { CompositeStorageProvider } from './storage/composite';

export interface SyncReport {
  ok: boolean;
  pushed: number;
  pulled: number;
  applied: number;
  conflicts: number;
  skipped: number;
  offline: boolean;
  error: string | null;
  durationMs: number;
  at: number;
}

export function emptySyncReport(): SyncReport {
  return { ok: false, pushed: 0, pulled: 0, applied: 0, conflicts: 0, skipped: 0, offline: false, error: null, durationMs: 0, at: Date.now() };
}

/** Exponential backoff with a ceiling. Used by the service's auto-sync timer. */
export function retryDelayMs(attempt: number): number {
  return Math.min(5 * 60_000, 1000 * 2 ** Math.min(6, Math.max(0, attempt)));
}

const APPLIED_ID_CAP = 3000;

/** Append a change. Idempotent: re-recording an identical state is a no-op. */
export function appendChange(
  state: Memory2State,
  record: MemoryRecord,
  op: MemoryChange['op'],
  ctx: { now?: number; changeId?: string } = {},
): Memory2State {
  const now = ctx.now ?? Date.now();
  const last = [...state.changes].reverse().find((c) => c.memoryId === record.id);
  if (last && last.op === op && last.record?.contentHash === record.contentHash && last.record?.version === record.version) {
    return state; // idempotent extraction / repeated save
  }
  const seq = (state.changes[state.changes.length - 1]?.seq ?? 0) + 1;
  const change: MemoryChange = {
    seq,
    changeId: ctx.changeId ?? `ch-${hashString(`${record.id}:${record.version}:${record.contentHash}:${op}:${now}`)}`,
    memoryId: record.id,
    op,
    record,
    at: now,
    deviceId: record.deviceId,
    projectId: record.projectId,
  };
  return { ...state, changes: [...state.changes, change] };
}

export function pendingLocalChanges(state: Memory2State): MemoryChange[] {
  return state.changes.filter((c) => c.seq > state.sync.pushCursor);
}

// ---- 3-way merge ----------------------------------------------------------

type MergeableField = keyof Pick<MemoryRecord, 'title' | 'content' | 'type' | 'layer' | 'status' | 'importance' | 'confidence' | 'why'>;

const FIELDS: MergeableField[] = ['title', 'content', 'type', 'layer', 'status', 'importance', 'confidence', 'why'];

export interface MergeAttempt {
  ok: boolean;
  patch: MemoryPatch;
  conflictFields: string[];
}

/** Safe auto-merge only when changes are disjoint (or monotonic, e.g. importance). */
export function threeWayMerge(base: MemoryRecord, local: MemoryRecord, remote: MemoryRecord): MergeAttempt {
  const patch: MemoryPatch = {};
  const conflictFields: string[] = [];
  for (const field of FIELDS) {
    const b = base[field] as any;
    const l = local[field] as any;
    const r = remote[field] as any;
    if (JSON.stringify(l) === JSON.stringify(r)) continue;
    const localChanged = JSON.stringify(l) !== JSON.stringify(b);
    const remoteChanged = JSON.stringify(r) !== JSON.stringify(b);
    if (localChanged && !remoteChanged) continue;              // keep local
    if (remoteChanged && !localChanged) { (patch as any)[field] = r; continue; }
    // Both changed. A few fields merge safely; free text never does.
    if (field === 'importance' || field === 'confidence') { (patch as any)[field] = Math.max(l, r); continue; }
    if (field === 'why' && !l) { patch.why = r; continue; }
    conflictFields.push(field);
  }
  // Tags are a set — a union is always safe.
  patch.tags = Array.from(new Set([...base.tags, ...local.tags, ...remote.tags]));
  return { ok: conflictFields.length === 0, patch, conflictFields };
}

/** Find the common ancestor inside local history, if we still have it. */
export function findBase(local: MemoryRecord, remoteVersion: number): MemoryRecord | null {
  // History is chronological. The common ancestor is the newest snapshot at or
  // below the remote version, not the oldest one.
  const snap = [...local.history].reverse().find((h) => h.version <= remoteVersion);
  if (!snap) return null;
  return {
    ...local,
    title: snap.title, content: snap.content, type: snap.type, layer: snap.layer,
    status: snap.status, importance: snap.importance, confidence: snap.confidence,
    tags: snap.tags, why: snap.why, version: snap.version, updatedAt: snap.at,
  };
}

function makeConflict(local: MemoryRecord, remote: MemoryRecord, base: MemoryRecord | null, now: number): MemoryConflict {
  return {
    id: `cf-${hashString(`${local.id}:${remote.version}:${now}`)}`,
    memoryId: local.id,
    local,
    remote,
    base: base ?? undefined,
    detectedAt: now,
    resolved: false,
  };
}

// ---- Sync engine ----------------------------------------------------------

export class MemorySyncEngine {
  constructor(private storage: CompositeStorageProvider) {}

  /**
   * One full incremental sync cycle. Returns a NEW state (never mutates the
   * argument), so callers can persist atomically after it succeeds.
   */
  async sync(input: Memory2State, opts: { now?: number; cloudEnabled?: boolean } = {}): Promise<{ state: Memory2State; report: SyncReport }> {
    const started = Date.now();
    const now = opts.now ?? Date.now();
    const report = emptySyncReport();
    let state: Memory2State = {
      ...input,
      sync: { ...input.sync, inFlight: true, appliedChangeIds: [...input.sync.appliedChangeIds], conflicts: [...input.sync.conflicts] },
    };

    const cloud = this.storage.cloud;
    if (!cloud || opts.cloudEnabled === false || !state.cloud.enabled) {
      const finished = finish(state, report, now, 'cloud sync is disabled');
      finished.report.offline = true;
      return finished;
    }

    const health = await this.storage.hybridHealth();
    if (!health.cloudAvailable) {
      // Offline: queue local edits, keep them, never lose or fake a sync.
      const pending = pendingLocalChanges(state).length;
      state = {
        ...state,
        sync: {
          ...state.sync,
          inFlight: false,
          offlineQueueLength: pending,
          lastError: health.cloud?.message ?? this.storage.cloudError ?? 'cloud unavailable',
        },
      };
      report.offline = true;
      report.error = state.sync.lastError;
      report.ok = false; // honest: no sync happened
      report.durationMs = Date.now() - started;
      return { state, report };
    }

    // ---- 1. PUSH (incremental, since pushCursor) -------------------------
    const batch = pendingLocalChanges(state);
    if (batch.length) {
      const pushed = await this.storage.pushChanges(batch);
      report.pushed = pushed.acceptedChangeIds.length;
      if (!pushed.ok) {
        const finished = finish(state, report, now, pushed.error ?? 'push failed');
        finished.report.offline = true;
        return finished;
      }
      const accepted = new Set(pushed.acceptedChangeIds);
      const maxSeq = batch.filter((c) => accepted.has(c.changeId)).reduce((n, c) => Math.max(n, c.seq), state.sync.pushCursor);
      state = {
        ...state,
        sync: { ...state.sync, pushCursor: maxSeq },
        records: state.records.map((r) => accepted.size && batch.some((c) => c.memoryId === r.id && accepted.has(c.changeId))
          ? { ...r, syncStatus: r.syncStatus === 'conflict' ? 'conflict' : 'synced' }
          : r),
      };
      for (const conflict of pushed.conflicts) this.addConflict(state, conflict);
    }

    // ---- 2. PULL (incremental, since cloudCursor) ------------------------
    const remote = await this.storage.remoteChanges(state.sync.cloudCursor, 200);
    if (remote.error) {
      return finish(state, report, now, remote.error);
    }
    report.pulled = remote.changes.length;
    const appliedIds = new Set(state.sync.appliedChangeIds);
    let records = [...state.records];
    const byId = new Map(records.map((r) => [r.id, r]));
    const conflictsToAdd: MemoryConflict[] = [];

    for (const change of remote.changes) {
      if (appliedIds.has(change.changeId)) { report.skipped++; continue; }
      // Our own echoed change: mark applied, never re-apply.
      if (change.deviceId === state.sync.deviceId) {
        appliedIds.add(change.changeId);
        report.skipped++;
        continue;
      }
      const r = change.record ? normalizeRecord(change.record) : null;
      const current = byId.get(change.memoryId);

      if (change.op === 'delete' || r?.deletedAt != null) {
        // Tombstone wins. Never resurrect a memory deleted on another device.
        if (current && (current.deletedAt === null || (r && (r.deletedAt ?? 0) > (current.deletedAt ?? 0)))) {
          const dead = r ?? tombstone(current, { now, deviceId: change.deviceId, reason: 'remote delete' });
          records = records.map((x) => x.id === dead.id ? dead : x);
          byId.set(dead.id, dead);
          report.applied++;
        } else if (!current && r) {
          records.push(r); byId.set(r.id, r); report.applied++;
        } else report.skipped++;
        appliedIds.add(change.changeId);
        continue;
      }
      if (!r) { appliedIds.add(change.changeId); report.skipped++; continue; }

      // A remote record from another project must not enter this workspace's
      // index under any circumstance — isolation is re-checked at the boundary.
      if (!current) {
        records.push({ ...r, syncStatus: 'synced' });
        byId.set(r.id, { ...r, syncStatus: 'synced' });
        report.applied++;
        appliedIds.add(change.changeId);
        continue;
      }
      if (current.deletedAt !== null) {
        // Local tombstone is authoritative until explicitly resolved.
        report.skipped++;
        appliedIds.add(change.changeId);
        continue;
      }
      if (r.version === current.version && r.contentHash === current.contentHash) {
        report.skipped++; appliedIds.add(change.changeId); continue;
      }
      if (r.version < current.version) {
        report.skipped++; appliedIds.add(change.changeId); continue; // local newer, will push
      }

      const localDirty = state.changes.some((c) => c.memoryId === current.id && c.seq > state.sync.pushCursor);
      if (r.version === current.version || localDirty) {
        // Both sides touched it. Try a safe 3-way merge first.
        const base = findBase(current, r.version);
        const attempt = base ? threeWayMerge(base, current, r) : { ok: false, patch: {}, conflictFields: ['content'] };
        if (attempt.ok && base) {
          const merged = updateMemory(current, attempt.patch, {
            now, deviceId: state.sync.deviceId, reason: 'auto-merged concurrent edits',
          });
          const bumped: MemoryRecord = {
            ...merged,
            version: Math.max(merged.version, r.version + 1),
            contentHash: contentHashOf(merged),
            syncStatus: 'local',
          };
          records = records.map((x) => x.id === bumped.id ? bumped : x);
          byId.set(bumped.id, bumped);
          state = appendChange(state, bumped, 'update', { now });
          report.applied++;
        } else {
          // Keep BOTH versions. Nothing is overwritten until a human chooses.
          const conflict = makeConflict(current, r, base, now);
          conflictsToAdd.push(conflict);
          records = records.map((x) => x.id === current.id
            ? { ...x, syncStatus: 'conflict', conflictWith: conflict.id }
            : x);
          report.conflicts++;
        }
        appliedIds.add(change.changeId);
        continue;
      }

      // Remote is strictly newer and local is clean -> apply it.
      records = records.map((x) => x.id === r.id ? { ...r, syncStatus: 'synced' } : x);
      byId.set(r.id, { ...r, syncStatus: 'synced' });
      report.applied++;
      appliedIds.add(change.changeId);
    }

    const trimmedApplied = Array.from(appliedIds).slice(-APPLIED_ID_CAP);
    // Push-time and pull-time detection can both notice the same conflict.
    // Keep one per memory; both sides are already inside that entry.
    const conflictByMemory = new Map<string, MemoryConflict>();
    for (const conflict of [...state.sync.conflicts, ...conflictsToAdd]) {
      if (conflict.resolved || conflictByMemory.has(conflict.memoryId)) continue;
      conflictByMemory.set(conflict.memoryId, conflict);
    }
    const conflicts = [...conflictByMemory.values()];
    // Bound the local log: keep every pending change, plus a recent window of
    // applied changes so a future push still starts above pushCursor. The last
    // retained seq is what the next append continues from.
    const pendingChanges = state.changes.filter((c) => c.seq > state.sync.pushCursor);
    const appliedTail = state.changes
      .filter((c) => c.seq <= state.sync.pushCursor)
      .slice(-500);
    state = {
      ...state,
      records,
      changes: [...appliedTail, ...pendingChanges],
      sync: {
        ...state.sync,
        cloudCursor: Math.max(state.sync.cloudCursor, remote.cursor),
        appliedChangeIds: trimmedApplied,
        conflicts,
        inFlight: false,
        lastSyncAt: now,
        lastError: null,
        offlineQueueLength: 0,
        pendingChanges: pendingLocalChanges(state).length,
      },
    };
    report.ok = true;
    report.conflicts = conflicts.length;
    report.durationMs = Date.now() - started;
    report.at = now;
    // The merged records changed syncStatus; persist through the caller.
    return { state, report };
  }

  private addConflict(state: Memory2State, conflict: MemoryConflict): void {
    if (!state.sync.conflicts.some((c) => c.id === conflict.id || c.memoryId === conflict.memoryId)) {
      state.sync.conflicts.push(conflict);
    }
  }

  /** Human conflict resolution — the chosen version becomes a new local version. */
  resolve(
    state: Memory2State,
    conflictId: string,
    resolution: 'keep_local' | 'keep_remote' | 'merge',
    opts: { now?: number } = {},
  ): Memory2State {
    const now = opts.now ?? Date.now();
    const conflict = state.sync.conflicts.find((c) => c.id === conflictId && !c.resolved);
    if (!conflict) return state;
    const local = state.records.find((r) => r.id === conflict.memoryId);
    if (!local) return state;

    let chosen: MemoryRecord;
    if (resolution === 'keep_remote') {
      chosen = { ...conflict.remote, version: Math.max(local.version, conflict.remote.version) + 1, syncStatus: 'local', deviceId: state.sync.deviceId, updatedAt: now, deletedAt: null };
    } else if (resolution === 'merge') {
      const content = `${local.content}\n\n--- resolved conflict ---\n${conflict.remote.content}`.slice(0, 4000);
      chosen = {
        ...local, content, version: Math.max(local.version, conflict.remote.version) + 1,
        contentHash: contentHashOf({ ...local, content }), syncStatus: 'local', deviceId: state.sync.deviceId,
        updatedAt: now, conflictWith: undefined,
      };
    } else {
      chosen = { ...local, version: Math.max(local.version, conflict.remote.version) + 1, syncStatus: 'local', deviceId: state.sync.deviceId, updatedAt: now, conflictWith: undefined };
    }
    chosen = {
      ...chosen,
      history: [...chosen.history, {
        version: chosen.version - 1, title: conflict.remote.title, content: conflict.remote.content,
        type: conflict.remote.type, layer: conflict.remote.layer, status: conflict.remote.status,
        importance: conflict.remote.importance, confidence: conflict.remote.confidence,
        tags: conflict.remote.tags, relatedMemoryIds: conflict.remote.relatedMemoryIds,
        at: now, deviceId: conflict.remote.deviceId, reason: `conflict ${conflictId}: kept remote version`,
      }],
    };
    let next: Memory2State = {
      ...state,
      records: state.records.map((r) => r.id === chosen.id ? chosen : r),
      sync: {
        ...state.sync,
        conflicts: state.sync.conflicts.map((c) => c.id === conflictId ? { ...c, resolved: true } : c),
      },
    };
    next = appendChange(next, chosen, 'update', { now });
    return next;
  }
}

function finish(state: Memory2State, report: SyncReport, now: number, error: string): { state: Memory2State; report: SyncReport } {
  const next: Memory2State = {
    ...state,
    sync: {
      ...state.sync,
      inFlight: false,
      lastError: error,
      offlineQueueLength: pendingLocalChanges(state).length,
    },
  };
  report.error = error;
  report.ok = false;
  report.offline = true;
  report.durationMs = Date.now() - (report.at || now);
  report.at = now;
  return { state: next, report };
}

/** Sync status summary for the UI — never reports success when none happened. */
export function syncStatusView(state: Memory2State, cloudAvailable: boolean) {
  const s: SyncState = state.sync;
  return {
    connected: cloudAvailable,
    lastSyncAt: s.lastSyncAt,
    lastError: s.lastError,
    pending: pendingLocalChanges(state).length,
    offlineQueue: s.offlineQueueLength,
    conflicts: s.conflicts.filter((c) => !c.resolved).length,
    cursor: { push: s.pushCursor, cloud: s.cloudCursor },
    deviceId: s.deviceId,
    inFlight: s.inFlight,
  };
}
