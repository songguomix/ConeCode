/**
 * Client-side weekly usage tracking for the gifted (ConeCode Free) model.
 *
 * The free relay is shared and capped at FREE_WEEKLY_TOKEN_LIMIT tokens per
 * week. Self-provided providers are never tracked or capped here — only the
 * free provider id is accounted for by the callers.
 *
 * DURABILITY: the counter used to live only in the renderer's localStorage
 * (Chromium leveldb). On Windows an unclean exit loses buffered writes and a
 * corrupted leveldb is discarded wholesale — after a restart the weekly count
 * silently read back as 0. The durable home is now the main-process JSON file
 * store (userData/data/freeUsage.json, same place as conversations and
 * settings) reached over IPC; localStorage is demoted to a one-time migration
 * source and an IPC-less fallback for tests.
 */

export const FREE_WEEKLY_TOKEN_LIMIT = 2_000_000_000;
export const FREE_USAGE_STORAGE_KEY = 'conecode.freeWeeklyUsage';
export const FREE_USAGE_RESET_KEY = 'conecode.freeUsageResetAt';

export interface FreeWeeklyUsageRecord {
  weekStart: number;
  used: number;
  /** Server timestamp of the last known usage reset (drives server-driven zeroing). */
  resetAt?: string | null;
}

function currentWeekStart(now: number = Date.now()): number {
  const d = new Date(now);
  const day = d.getDay(); // 0 = Sunday
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Pure record transforms — shared by the main-process file store and tests.
// ---------------------------------------------------------------------------

/** Add tokens to a record, rolling the week over when the anchor moved on. */
export function applyRecordedUsage(
  record: FreeWeeklyUsageRecord | null,
  tokens: number,
  now: number = Date.now(),
): FreeWeeklyUsageRecord {
  const weekStart = currentWeekStart(now);
  const base = record && record.weekStart === weekStart ? Math.max(0, record.used) : 0;
  const amount = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  return { weekStart, used: base + amount, resetAt: record?.resetAt ?? null };
}

/**
 * Roll the counter into the current week, then apply a newer server reset.
 * Returns the current record and whether either kind of reset was applied.
 */
export function applyServerResetTo(
  record: FreeWeeklyUsageRecord | null,
  serverResetAt: string | null,
  now: number = Date.now(),
): { record: FreeWeeklyUsageRecord; changed: boolean } {
  const weekStart = currentWeekStart(now);
  const current = applyRecordedUsage(record, 0, now);
  const rolledOver = record !== null && record.weekStart !== weekStart;
  const serverTime = serverResetAt ? new Date(serverResetAt).getTime() : NaN;
  if (!Number.isFinite(serverTime)) {
    return { record: current, changed: rolledOver };
  }
  const localTime = record?.resetAt ? new Date(record.resetAt).getTime() : null;
  if (localTime !== null && !(serverTime > localTime)) {
    return { record: current, changed: rolledOver };
  }
  return {
    record: { weekStart, used: 0, resetAt: new Date(serverTime).toISOString() },
    changed: true,
  };
}

/**
 * Migration merge: adopt the legacy localStorage count when the file store has
 * nothing for this week; keep the LARGER of the two otherwise, so an interrupted
 * migration can never under-count. The file record wins on the reset marker.
 */
export function hydrateRecords(
  fileRecord: FreeWeeklyUsageRecord | null,
  legacyRecord: FreeWeeklyUsageRecord | null,
  now: number = Date.now(),
): FreeWeeklyUsageRecord {
  const weekStart = currentWeekStart(now);
  const fileUsed = fileRecord && fileRecord.weekStart === weekStart ? Math.max(0, fileRecord.used) : 0;
  const legacyUsed = legacyRecord && legacyRecord.weekStart === weekStart ? Math.max(0, legacyRecord.used) : 0;
  return {
    weekStart,
    used: Math.max(fileUsed, legacyUsed),
    resetAt: fileRecord?.resetAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Legacy localStorage layer — migration source + IPC-less fallback only.
// ---------------------------------------------------------------------------

function legacyStorage(): Storage | null {
  try {
    return (globalThis as any)?.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Same-week usage from the legacy localStorage counter, or null. */
export function loadLegacyLocalUsage(now: number = Date.now()): FreeWeeklyUsageRecord | null {
  const storage = legacyStorage();
  try {
    const raw = storage?.getItem?.(FREE_USAGE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.weekStart === 'number' && typeof parsed.used === 'number') {
        if (parsed.weekStart === currentWeekStart(now)) {
          return { weekStart: parsed.weekStart, used: Math.max(0, parsed.used) };
        }
      }
    }
  } catch {}
  return null;
}

function legacyRecordUsage(tokens: number, now: number = Date.now()): number {
  const next = applyRecordedUsage(loadLegacyLocalUsage(now), tokens, now);
  try {
    legacyStorage()?.setItem?.(FREE_USAGE_STORAGE_KEY, JSON.stringify({ weekStart: next.weekStart, used: next.used }));
  } catch {}
  return next.used;
}

function legacyResetUsage(now: number = Date.now()): void {
  try {
    legacyStorage()?.setItem?.(FREE_USAGE_STORAGE_KEY, JSON.stringify({ weekStart: currentWeekStart(now), used: 0 }));
  } catch {}
}

function legacyApplyServerReset(serverResetAt: string | null, now: number = Date.now()): boolean {
  if (!serverResetAt) return false;
  let local: string | null = null;
  try {
    const raw = legacyStorage()?.getItem?.(FREE_USAGE_RESET_KEY);
    local = typeof raw === 'string' && raw !== '' ? raw : null;
  } catch {}
  if (local !== null && !(new Date(serverResetAt).getTime() > new Date(local).getTime())) return false;
  legacyResetUsage(now);
  try {
    legacyStorage()?.setItem?.(FREE_USAGE_RESET_KEY, serverResetAt);
  } catch {}
  return true;
}

// ---------------------------------------------------------------------------
// Renderer API — durable main-process file store over IPC, legacy fallback.
// ---------------------------------------------------------------------------

interface FreeUsageBridge {
  usageGet?: () => Promise<FreeWeeklyUsageRecord | null>;
  usageRecord?: (tokens: number) => Promise<FreeWeeklyUsageRecord>;
  usageReset?: (serverResetAt: string | null) => Promise<FreeWeeklyUsageRecord>;
  usageSync?: (serverResetAt: string | null) => Promise<{ record: FreeWeeklyUsageRecord; changed: boolean }>;
  usageHydrate?: (legacy: FreeWeeklyUsageRecord | null) => Promise<FreeWeeklyUsageRecord>;
}

function bridge(): FreeUsageBridge | null {
  try {
    return (globalThis as any)?.window?.electronAPI?.free ?? null;
  } catch {
    return null;
  }
}

/** Durable counter read. Falls back to the legacy localStorage value. */
export async function loadFreeUsageRecord(): Promise<number> {
  const api = bridge();
  if (api?.usageGet) {
    try {
      const record = await api.usageGet();
      const weekStart = currentWeekStart();
      if (record && record.weekStart === weekStart) return Math.max(0, record.used);
      return 0;
    } catch {}
  }
  return loadLegacyLocalUsage()?.used ?? 0;
}

/** Add tokens to the durable counter; returns the new weekly total. */
export async function recordFreeUsage(tokens: number): Promise<number> {
  const api = bridge();
  if (api?.usageRecord) {
    try {
      const record = await api.usageRecord(tokens);
      return Math.max(0, record?.used ?? 0);
    } catch {}
  }
  return legacyRecordUsage(tokens);
}

/**
 * Apply a server-driven reset to the durable counter (no-op unless the marker
 * is newer than what we recorded) and return the current weekly total plus
 * whether a reset was applied this call.
 */
export async function syncFreeUsage(serverResetAt: string | null): Promise<{ used: number; didReset: boolean }> {
  const api = bridge();
  if (api?.usageSync) {
    try {
      const { record, changed } = await api.usageSync(serverResetAt);
      return { used: Math.max(0, record?.used ?? 0), didReset: changed };
    } catch {}
  }
  const didReset = legacyApplyServerReset(serverResetAt);
  return { used: loadLegacyLocalUsage()?.used ?? 0, didReset };
}

/** Force-zero the durable counter (manual reset). */
export async function resetFreeUsage(): Promise<void> {
  const api = bridge();
  if (api?.usageReset) {
    try {
      await api.usageReset(null);
      return;
    } catch {}
  }
  legacyResetUsage();
}

let legacyMigrated = false;

/**
 * One-time migration: hand the legacy localStorage counter to the file store.
 * Idempotent per session; a no-op once the file store holds this week's count.
 */
export async function hydrateFreeUsage(): Promise<number> {
  const api = bridge();
  if (api?.usageHydrate) {
    if (legacyMigrated) {
      try {
        const record = await api.usageGet?.();
        if (record) return Math.max(0, record.used);
      } catch {}
      return 0;
    }
    legacyMigrated = true;
    try {
      const record = await api.usageHydrate(loadLegacyLocalUsage());
      return Math.max(0, record?.used ?? 0);
    } catch {}
  }
  return loadLegacyLocalUsage()?.used ?? 0;
}

// Back-compat synchronous helpers (legacy localStorage). New code should use
// the async API above.
export function loadFreeWeeklyUsage(now: number = Date.now()): FreeWeeklyUsageRecord {
  const used = loadLegacyLocalUsage(now)?.used ?? 0;
  return { weekStart: currentWeekStart(now), used };
}

export function saveFreeWeeklyUsage(record: FreeWeeklyUsageRecord): void {
  try {
    legacyStorage()?.setItem?.(FREE_USAGE_STORAGE_KEY, JSON.stringify({ weekStart: record.weekStart, used: record.used }));
  } catch {}
}

export function getFreeWeeklyUsed(now: number = Date.now()): number {
  return loadFreeWeeklyUsage(now).used;
}

export function isFreeWeeklyLimitReached(used?: number): boolean {
  const value = typeof used === 'number' ? used : getFreeWeeklyUsed();
  return value >= FREE_WEEKLY_TOKEN_LIMIT;
}

/** Legacy localStorage-only weekly reset (kept for compat re-exports). */
export function resetFreeWeeklyUsage(now: number = Date.now()): void {
  legacyResetUsage(now);
}

/** Legacy localStorage-only server-reset application (kept for compat). */
export function applyFreeUsageReset(serverResetAt: string | null, now: number = Date.now()): boolean {
  return legacyApplyServerReset(serverResetAt, now);
}

export const FREE_WEEKLY_LIMIT = FREE_WEEKLY_TOKEN_LIMIT;
export const WEEKLY_LIMIT = FREE_WEEKLY_TOKEN_LIMIT;
export const FREE_WEEKLY_CAP = FREE_WEEKLY_TOKEN_LIMIT;
export const FREE_WEEKLY_TOKEN_CAP = FREE_WEEKLY_TOKEN_LIMIT;
export const WEEKLY_TOKEN_LIMIT = FREE_WEEKLY_TOKEN_LIMIT;
