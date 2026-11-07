import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFreeStore } from './free.store';
import { useModelStore } from './model.store';
import { FREE_PROVIDER_ID } from '../core/providers/free.adapter';
import { applyRecordedUsage, applyServerResetTo, FREE_WEEKLY_TOKEN_LIMIT } from '../core/providers/freeUsage';
import type { AIModel } from '../types';

const model = (id: string): AIModel => ({ id, name: id, providerId: FREE_PROVIDER_ID, supportsText: true, supportsVision: false, supportsFunctionCalling: true, supportsReasoning: false, contextWindow: 128000, maxOutputTokens: 8192, enabled: true } as AIModel);
const openStatus = (models: AIModel[]) => ({ available: true, mode: 'on' as const, startsAt: null, endsAt: null, models });
beforeEach(() => {
  useFreeStore.setState({ status: null, loading: false, error: null });
  useModelStore.setState({ models: new Map(), selectedModelId: null, selectedProviderId: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('syncs gifted models, replaces removed models and clears selection on close', async () => {
  let available = true;
  let models = [model('first')];
  vi.stubGlobal('window', { electronAPI: {
    free: { status: async () => ({ available, mode: available ? 'on' : 'off', startsAt: null, endsAt: null, models: available ? models : [] }) },
    model: { list: async () => models },
  } });
  await useFreeStore.getState().refresh();
  expect(useModelStore.getState().getSelectedModel()?.id).toBe('first');
  models = [model('replacement')];
  await useFreeStore.getState().refresh();
  expect(useModelStore.getState().models.get(FREE_PROVIDER_ID)?.map((m) => m.id)).toEqual(['replacement']);
  expect(useModelStore.getState().getSelectedModel()?.id).toBe('replacement');
  available = false;
  await useFreeStore.getState().refresh();
  expect(useModelStore.getState().models.has(FREE_PROVIDER_ID)).toBe(false);
  expect(useModelStore.getState().selectedModelId).toBe(null);
});
it('drops offline free models and only exposes a fixed error when status fails', async () => {
  useModelStore.setState({ models: new Map([[FREE_PROVIDER_ID, [model('old')]]]), selectedModelId: 'old', selectedProviderId: FREE_PROVIDER_ID });
  vi.stubGlobal('window', { electronAPI: { free: { status: async () => { throw new Error('https://secret-provider.example sk-private'); } } } });
  await useFreeStore.getState().refresh();
  expect(useModelStore.getState().models.has(FREE_PROVIDER_ID)).toBe(false);
  expect(useFreeStore.getState().error).not.toMatch(/https?:|sk-private/);
  expect(useFreeStore.getState().loading).toBe(false);
});

it.each(['empty', 'rejected'] as const)('retries a failed model refresh (%s) after a successful status response', async (failure) => {
  const old = model('old');
  const replacement = model('replacement');
  useFreeStore.setState({ status: openStatus([old]) });
  useModelStore.setState({ models: new Map([[FREE_PROVIDER_ID, [old]]]), selectedModelId: old.id, selectedProviderId: FREE_PROVIDER_ID });
  const list = vi.fn<() => Promise<AIModel[]>>();
  if (failure === 'empty') list.mockResolvedValueOnce([]);
  else list.mockRejectedValueOnce(new Error('temporary model request failure'));
  list.mockResolvedValue([replacement]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('window', { electronAPI: {
    free: { status: async () => openStatus([replacement]) },
    model: { list },
  } });

  await useFreeStore.getState().refresh();
  expect(useFreeStore.getState().status).toBeNull();
  expect(useFreeStore.getState().error).toBeTruthy();
  expect(useModelStore.getState().models.has(FREE_PROVIDER_ID)).toBe(false);

  await useFreeStore.getState().refresh();
  expect(list).toHaveBeenCalledTimes(2);
  expect(useFreeStore.getState().error).toBeNull();
  expect(useModelStore.getState().getSelectedModel()?.id).toBe(replacement.id);
});

it('repairs an existing empty model cache when status still advertises models', async () => {
  const first = model('first');
  const status = openStatus([first]);
  useFreeStore.setState({ status });
  useModelStore.setState({ models: new Map([[FREE_PROVIDER_ID, []]]) });
  const list = vi.fn(async () => [first]);
  vi.stubGlobal('window', { electronAPI: {
    free: { status: async () => status },
    model: { list },
  } });

  await useFreeStore.getState().refresh();
  expect(list).toHaveBeenCalledTimes(1);
  expect(useModelStore.getState().getSelectedModel()?.id).toBe(first.id);
});

it('accepts a legitimately empty status without repeatedly fetching models', async () => {
  const list = vi.fn(async () => []);
  vi.stubGlobal('window', { electronAPI: {
    free: { status: async () => openStatus([]) },
    model: { list },
  } });

  await useFreeStore.getState().refresh();
  await useFreeStore.getState().refresh();
  expect(list).toHaveBeenCalledTimes(1);
  expect(useFreeStore.getState().error).toBeNull();
});

it('keeps the durable weekly count across refresh — a restart must not reset it', async () => {
  // Models the main-process file store: hydrate hands back last session's
  // count, sync returns it unchanged, record accumulates in the file.
  let fileUsed = 555;
  vi.stubGlobal('window', { electronAPI: { free: {
    status: async () => ({ available: true, mode: 'on', startsAt: null, endsAt: null, models: [model('first')] }),
    usageHydrate: async () => ({ weekStart: 1, used: fileUsed, resetAt: null }),
    usageSync: async () => ({ record: { weekStart: 1, used: fileUsed, resetAt: null }, changed: false }),
    usageRecord: async (tokens: number) => ({ weekStart: 1, used: (fileUsed += tokens), resetAt: null }),
  }, model: { list: async () => [model('first')] } } });

  await useFreeStore.getState().refresh();
  expect(useFreeStore.getState().weeklyUsed).toBe(555);

  useFreeStore.getState().recordUsage(100);
  await vi.waitFor(() => expect(useFreeStore.getState().weeklyUsed).toBe(655));

  // Another refresh (what a restart does) reads the durable count, not zero.
  await useFreeStore.getState().refresh();
  expect(useFreeStore.getState().weeklyUsed).toBe(655);
});

it('applies a newer server reset marker and zeroes stale server mirrors', async () => {
  useFreeStore.setState({ weeklyUsed: 999, weeklyUsage: { used: 999, limit: 1 }, usage: { used: 999, limit: 1 } });
  vi.stubGlobal('window', { electronAPI: { free: {
    status: async () => ({
      available: true, mode: 'on', startsAt: null, endsAt: null, models: [],
      usage: { used: 999, limit: 2000000000 },
      usedTokens: 999, weeklyUsed: 999,
      usageResetAt: '2026-10-26T00:00:00Z',
    }),
    usageHydrate: async () => ({ weekStart: 1, used: 999, resetAt: null }),
    usageSync: async () => ({ record: { weekStart: 1, used: 0, resetAt: '2026-10-26T00:00:00.000Z' }, changed: true }),
  }, model: { list: async () => [] } } });

  await useFreeStore.getState().refresh();
  expect(useFreeStore.getState().weeklyUsed).toBe(0);
  // The stale server-reported usage is zeroed for display too.
  expect(useFreeStore.getState().status?.weeklyUsed).toBe(0);
  expect(useFreeStore.getState().status?.usage?.used).toBe(0);
});

it('clears an exhausted weekly allowance on refresh across Monday without restarting', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 1, 23, 59));
  const resetAt = '2026-10-26T00:00:00.000Z';
  let fileRecord = { ...applyRecordedUsage(null, FREE_WEEKLY_TOKEN_LIMIT), resetAt };
  const first = model('first');
  vi.stubGlobal('window', { electronAPI: {
    free: {
      status: async () => ({ ...openStatus([first]), usageResetAt: resetAt }),
      usageHydrate: async () => fileRecord,
      usageGet: async () => fileRecord,
      usageSync: async (marker: string | null) => {
        const result = applyServerResetTo(fileRecord, marker);
        fileRecord = { ...result.record, resetAt: result.record.resetAt! };
        return result;
      },
    },
    model: { list: async () => [first] },
  } });

  await useFreeStore.getState().refresh();
  expect(useFreeStore.getState().weeklyUsed).toBe(FREE_WEEKLY_TOKEN_LIMIT);
  vi.setSystemTime(new Date(2026, 10, 2, 0, 1));
  await useFreeStore.getState().refresh();
  expect(useFreeStore.getState().weeklyUsed).toBe(0);
  expect(fileRecord.used).toBe(0);
  expect(fileRecord.resetAt).toBe(resetAt);
});
