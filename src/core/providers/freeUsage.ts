/**
 * Client-side weekly usage tracking for the gifted (ConeCode Free) model.
 *
 * The free relay is shared and capped at FREE_WEEKLY_TOKEN_LIMIT tokens per
 * week. Self-provided providers are never tracked or capped here — only the
 * free provider id is accounted for by the callers.
 */

export const FREE_WEEKLY_TOKEN_LIMIT = 2_000_000_000;
export const FREE_USAGE_STORAGE_KEY = 'conecode.freeWeeklyUsage';
export const FREE_USAGE_RESET_KEY = 'conecode.freeUsageResetAt';

export interface FreeWeeklyUsageRecord {
  weekStart: number;
  used: number;
}

function currentWeekStart(now: number = Date.now()): number {
  const d = new Date(now);
  const day = d.getDay(); // 0 = Sunday
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function loadFreeWeeklyUsage(now: number = Date.now()): FreeWeeklyUsageRecord {
  try {
    const raw = (globalThis as any)?.localStorage?.getItem?.(FREE_USAGE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.weekStart === 'number' && typeof parsed.used === 'number') {
        if (parsed.weekStart === currentWeekStart(now)) {
          return { weekStart: parsed.weekStart, used: Math.max(0, parsed.used) };
        }
      }
    }
  } catch {}
  return { weekStart: currentWeekStart(now), used: 0 };
}

export function saveFreeWeeklyUsage(record: FreeWeeklyUsageRecord): void {
  try {
    (globalThis as any)?.localStorage?.setItem?.(FREE_USAGE_STORAGE_KEY, JSON.stringify(record));
  } catch {}
}

export function getFreeWeeklyUsed(now: number = Date.now()): number {
  return loadFreeWeeklyUsage(now).used;
}

export function recordFreeUsage(tokens: number, now: number = Date.now()): number {
  const prev = loadFreeWeeklyUsage(now);
  const weekStart = currentWeekStart(now);
  const base = prev.weekStart === weekStart ? prev.used : 0;
  const amount = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  const next: FreeWeeklyUsageRecord = { weekStart, used: base + amount };
  saveFreeWeeklyUsage(next);
  return next.used;
}

export function resetFreeWeeklyUsage(now: number = Date.now()): void {
  saveFreeWeeklyUsage({ weekStart: currentWeekStart(now), used: 0 });
}

export function isFreeWeeklyLimitReached(used?: number): boolean {
  const value = typeof used === 'number' ? used : getFreeWeeklyUsed();
  return value >= FREE_WEEKLY_TOKEN_LIMIT;
}

export function loadFreeUsageResetAt(): string | null {
  try {
    const raw = (globalThis as any)?.localStorage?.getItem?.(FREE_USAGE_RESET_KEY);
    return typeof raw === 'string' && raw !== '' ? raw : null;
  } catch { return null; }
}

export function saveFreeUsageResetAt(value: string | null): void {
  try {
    if (value) (globalThis as any)?.localStorage?.setItem?.(FREE_USAGE_RESET_KEY, value);
    else (globalThis as any)?.localStorage?.removeItem?.(FREE_USAGE_RESET_KEY);
  } catch {}
}

/**
 * 若服务器的重置标记比本地更新，则清零周用量并记录新标记；返回是否发生了重置。
 */
export function applyFreeUsageReset(serverResetAt: string | null): boolean {
  if (!serverResetAt) return false;
  const local = loadFreeUsageResetAt();
  if (local !== null && !(new Date(serverResetAt).getTime() > new Date(local).getTime())) return false;
  resetFreeWeeklyUsage();
  saveFreeUsageResetAt(serverResetAt);
  return true;
}

export const FREE_WEEKLY_LIMIT = FREE_WEEKLY_TOKEN_LIMIT;
export const WEEKLY_LIMIT = FREE_WEEKLY_TOKEN_LIMIT;
export const FREE_WEEKLY_CAP = FREE_WEEKLY_TOKEN_LIMIT;
export const FREE_WEEKLY_TOKEN_CAP = FREE_WEEKLY_TOKEN_LIMIT;
export const WEEKLY_TOKEN_LIMIT = FREE_WEEKLY_TOKEN_LIMIT;
