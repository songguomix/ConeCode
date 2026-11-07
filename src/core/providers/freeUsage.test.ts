import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRecordedUsage, applyServerResetTo, hydrateRecords,
  recordFreeUsage, syncFreeUsage, hydrateFreeUsage,
  FREE_WEEKLY_TOKEN_LIMIT,
} from './freeUsage';
import type { FreeWeeklyUsageRecord } from './freeUsage';

// Pure record transforms — the durable main-process file store and the legacy
// localStorage fallback both build on these.

describe('applyRecordedUsage', () => {
  it('accumulates within the same week', () => {
    const first = applyRecordedUsage(null, 500);
    expect(first.used).toBe(500);
    expect(applyRecordedUsage(first, 300).used).toBe(800);
  });

  it('rolls the week over: an old anchor does not carry into the new week', () => {
    const lastWeek = applyRecordedUsage(null, 999, Date.now() - 8 * 24 * 3600 * 1000);
    const thisWeek = applyRecordedUsage(lastWeek, 100);
    expect(thisWeek.used).toBe(100);
    expect(thisWeek.weekStart).not.toBe(lastWeek.weekStart);
  });

  it('ignores negative and non-finite tokens', () => {
    const record = applyRecordedUsage(null, 100);
    expect(applyRecordedUsage(record, -5).used).toBe(100);
    expect(applyRecordedUsage(record, Number.NaN).used).toBe(100);
    expect(applyRecordedUsage(record, Number.POSITIVE_INFINITY).used).toBe(100);
  });
});

describe('applyServerResetTo — the server-driven reset marker', () => {
  const now = Date.now();
  const sameWeek = applyRecordedUsage(null, 123456, now);

  it('zeros the counter once for a NEWER marker and stamps it', () => {
    const { record, changed } = applyServerResetTo(sameWeek, '2026-10-26T00:00:00Z', now);
    expect(changed).toBe(true);
    expect(record.used).toBe(0);
    expect(record.resetAt).toBe('2026-10-26T00:00:00.000Z');
  });

  it('is stable across restarts: the SAME marker never resets again', () => {
    const stamped: FreeWeeklyUsageRecord = { ...sameWeek, resetAt: '2026-10-26T00:00:00.000Z' };
    const after = applyServerResetTo(stamped, '2026-10-26T00:00:00Z', now);
    expect(after.changed).toBe(false);
    expect(after.record.used).toBe(123456);
    // Even an older marker must not touch the counter.
    const older = applyServerResetTo(stamped, '2026-01-01T00:00:00Z', now);
    expect(older.changed).toBe(false);
    expect(older.record.used).toBe(123456);
  });

  it('treats a missing local record as resettable and null/invalid markers as no-ops', () => {
    expect(applyServerResetTo(null, '2026-10-26T00:00:00Z', now).changed).toBe(true);
    expect(applyServerResetTo(sameWeek, null, now).changed).toBe(false);
    expect(applyServerResetTo(sameWeek, 'not a date', now).changed).toBe(false);
  });

  it.each([null, 'not a date', '2026-10-26T00:00:00Z', '2026-01-01T00:00:00Z'])('rolls an exhausted counter into the new week with marker %s', (marker) => {
    const resetAt = '2026-10-26T00:00:00.000Z';
    const lastWeek = {
      ...applyRecordedUsage(null, FREE_WEEKLY_TOKEN_LIMIT, new Date(2026, 9, 28, 12).getTime()),
      resetAt,
    };
    const nextWeek = new Date(2026, 10, 4, 12).getTime();
    const { record, changed } = applyServerResetTo(lastWeek, marker, nextWeek);
    expect(changed).toBe(true);
    expect(record.used).toBe(0);
    expect(record.weekStart).toBe(applyRecordedUsage(null, 0, nextWeek).weekStart);
    expect(record.resetAt).toBe(resetAt);

    const afterUsage = applyRecordedUsage(record, 100, nextWeek);
    expect(applyServerResetTo(afterUsage, marker, nextWeek)).toEqual({ record: afterUsage, changed: false });
  });
});

describe('hydrateRecords — the localStorage migration merge', () => {
  const now = Date.now();
  const anchor = hydrateRecords(null, null, now).weekStart;

  it('adopts the legacy count when the file store has nothing yet', () => {
    const merged = hydrateRecords(null, { weekStart: anchor, used: 300 }, now);
    expect(merged.used).toBe(300);
  });

  it('keeps the larger of the two so an interrupted migration cannot under-count', () => {
    expect(hydrateRecords({ weekStart: anchor, used: 100 }, { weekStart: anchor, used: 300 }, now).used).toBe(300);
    expect(hydrateRecords({ weekStart: anchor, used: 400 }, { weekStart: anchor, used: 300 }, now).used).toBe(400);
  });

  it('ignores legacy counts from an older week', () => {
    const stale = hydrateRecords({ weekStart: anchor, used: 100 }, { weekStart: anchor - 8 * 24 * 3600 * 1000, used: 999 }, now);
    expect(stale.used).toBe(100);
  });

  it('the file record keeps its reset marker', () => {
    const merged = hydrateRecords({ weekStart: anchor, used: 5, resetAt: '2026-10-26T00:00:00.000Z' }, { weekStart: anchor, used: 1 }, now);
    expect(merged.resetAt).toBe('2026-10-26T00:00:00.000Z');
  });
});

// Renderer API over the IPC bridge.

describe('renderer usage API (IPC bridge)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('records and syncs through the durable file store', async () => {
    const usageRecord = vi.fn(async (tokens: number) => ({ weekStart: 1, used: 100 + tokens, resetAt: null }));
    const usageSync = vi.fn(async () => ({ record: { weekStart: 1, used: 4321, resetAt: null }, changed: false }));
    vi.stubGlobal('window', { electronAPI: { free: { usageRecord, usageSync } } });

    await expect(recordFreeUsage(50)).resolves.toBe(150);
    expect(usageRecord).toHaveBeenCalledWith(50);

    const sync = await syncFreeUsage('2026-10-26T00:00:00Z');
    expect(sync).toEqual({ used: 4321, didReset: false });
    expect(usageSync).toHaveBeenCalledWith('2026-10-26T00:00:00Z');
  });

  it('reports the server reset so the UI can zero stale server mirrors', async () => {
    const usageSync = vi.fn(async () => ({ record: { weekStart: 1, used: 0, resetAt: '2026-10-26T00:00:00.000Z' }, changed: true }));
    vi.stubGlobal('window', { electronAPI: { free: { usageSync } } });
    await expect(syncFreeUsage('2026-10-26T00:00:00Z')).resolves.toEqual({ used: 0, didReset: true });
  });

  it('migrates the legacy localStorage counter exactly once per session', async () => {
    const usageHydrate = vi.fn(async () => ({ weekStart: 1, used: 777, resetAt: null }));
    const usageGet = vi.fn(async () => ({ weekStart: 1, used: 777, resetAt: null }));
    vi.stubGlobal('window', { electronAPI: { free: { usageHydrate, usageGet } } });

    await expect(hydrateFreeUsage()).resolves.toBe(777);
    expect(usageHydrate).toHaveBeenCalledTimes(1);
    // Second call reads the file store instead of re-handing over legacy data.
    await expect(hydrateFreeUsage()).resolves.toBe(777);
    expect(usageHydrate).toHaveBeenCalledTimes(1);
    expect(usageGet).toHaveBeenCalledTimes(1);
  });

  it('falls back to localStorage when the IPC bridge is missing', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {});
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };

    await expect(recordFreeUsage(100)).resolves.toBe(100);
    await expect(recordFreeUsage(23)).resolves.toBe(123);
    expect(JSON.parse(store.get('conecode.freeWeeklyUsage')!)).toMatchObject({ used: 123 });

    await expect(syncFreeUsage('2026-10-26T00:00:00Z')).resolves.toMatchObject({ used: 0, didReset: true });
    expect(JSON.parse(store.get('conecode.freeWeeklyUsage')!)).toMatchObject({ used: 0 });

    delete (globalThis as any).localStorage;
  });
});
