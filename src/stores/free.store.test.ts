import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFreeStore } from './free.store';
import { useModelStore } from './model.store';
import { FREE_PROVIDER_ID, type FreeCatalog } from '../core/providers/free.adapter';
import { applyRecordedUsage, applyServerResetTo, FREE_WEEKLY_TOKEN_LIMIT } from '../core/providers/freeUsage';
import type { AIModel } from '../types';

const model = (id: string): AIModel => ({ id, name: id, providerId: FREE_PROVIDER_ID, supportsText: true, supportsVision: false, supportsFunctionCalling: true, supportsReasoning: false, contextWindow: 128000, maxOutputTokens: 8192, enabled: true } as AIModel);
const catalog = (models: AIModel[], available = true): FreeCatalog => ({
  status: { available, mode: available ? 'on' : 'off', startsAt: null, endsAt: null, models: available ? models : [] },
  models: available ? models : [],
});
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
    free: { status: async () => catalog(models, available) },
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

it('loads models from the same live status response and retries the status after a failure', async () => {
  const first = model('first');
  const status = vi.fn<() => Promise<FreeCatalog>>()
    .mockRejectedValueOnce(new Error('temporary status failure'))
    .mockResolvedValue(catalog([first]));
  const list = vi.fn(async () => []);
  vi.stubGlobal('window', { electronAPI: {
    free: { status },
    model: { list },
  } });

  await useFreeStore.getState().refresh();
  expect(useFreeStore.getState().status).toBeNull();
  expect(useFreeStore.getState().error).toBeTruthy();
  expect(useModelStore.getState().models.has(FREE_PROVIDER_ID)).toBe(false);

  await useFreeStore.getState().refresh();
  expect(status).toHaveBeenCalledTimes(2);
  expect(list).not.toHaveBeenCalled();
  expect(useFreeStore.getState().error).toBeNull();
  expect(useModelStore.getState().getSelectedModel()?.id).toBe(first.id);
});

it('accepts an open but empty status without a second model request', async () => {
  const list = vi.fn(async () => []);
  vi.stubGlobal('window', { electronAPI: {
    free: { status: async () => catalog([]) },
    model: { list },
  } });

  await useFreeStore.getState().refresh();
  await useFreeStore.getState().refresh();
  expect(list).not.toHaveBeenCalled();
  expect(useFreeStore.getState().error).toBeNull();
});

it('does not restore closed Free models when a slower provider finishes loading', async () => {
  const first = model('first');
  let finishOtherProvider!: (models: AIModel[]) => void;
  const otherModels = new Promise<AIModel[]>((resolve) => { finishOtherProvider = resolve; });
  vi.stubGlobal('window', { electronAPI: {
    provider: { list: async () => [
      { id: FREE_PROVIDER_ID, enabled: true },
      { id: 'slow-provider', enabled: true },
    ] },
    model: { list: (id: string) => id === FREE_PROVIDER_ID ? Promise.resolve([first]) : otherModels },
    free: { status: async () => catalog([], false) },
  } });

  const load = useModelStore.getState().fetchAllModels();
  await vi.waitFor(() => expect(useModelStore.getState().models.get(FREE_PROVIDER_ID)?.[0].id).toBe(first.id));
  await useFreeStore.getState().refresh();
  finishOtherProvider([]);
  await load;
  expect(useModelStore.getState().models.has(FREE_PROVIDER_ID)).toBe(false);
});

it('keeps the durable weekly count across refresh — a restart must not reset it', async () => {
  // Models the main-process file store: hydrate hands back last session's
  // count, sync returns it unchanged, record accumulates in the file.
  let fileUsed = 555;
  vi.stubGlobal('window', { electronAPI: { free: {
    status: async () => catalog([model('first')]),
    usageHydrate: async () => ({ weekStart: 1, used: fileUsed, resetAt: null }),
    usageSync: async () => ({ record: { weekStart: 1, used: fileUsed, resetAt: null }, changed: false }),
    usageRecord: async (tokens: number) => ({ weekStart: 1, used: (fileUsed += tokens), resetAt: null }),
  } } });

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
    status: async () => ({ ...catalog([]), status: {
      ...catalog([]).status,
      usage: {
        used: 999, usedTokens: 999, tokensUsed: 999, weeklyUsed: 999,
        limit: FREE_WEEKLY_TOKEN_LIMIT, weeklyLimit: FREE_WEEKLY_TOKEN_LIMIT, tokenLimit: FREE_WEEKLY_TOKEN_LIMIT,
        resetsAt: null, resetAt: null,
      },
      usedTokens: 999, weeklyUsed: 999,
      usageResetAt: '2026-10-26T00:00:00Z',
    } }),
    usageHydrate: async () => ({ weekStart: 1, used: 999, resetAt: null }),
    usageSync: async () => ({ record: { weekStart: 1, used: 0, resetAt: '2026-10-26T00:00:00.000Z' }, changed: true }),
  } } });

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
      status: async () => ({ models: [first], status: { ...catalog([first]).status, usageResetAt: resetAt } }),
      usageHydrate: async () => fileRecord,
      usageGet: async () => fileRecord,
      usageSync: async (marker: string | null) => {
        const result = applyServerResetTo(fileRecord, marker);
        fileRecord = { ...result.record, resetAt: result.record.resetAt! };
        return result;
      },
    },
  } });

  await useFreeStore.getState().refresh();
  expect(useFreeStore.getState().weeklyUsed).toBe(FREE_WEEKLY_TOKEN_LIMIT);
  vi.setSystemTime(new Date(2026, 10, 2, 0, 1));
  await useFreeStore.getState().refresh();
  expect(useFreeStore.getState().weeklyUsed).toBe(0);
  expect(fileRecord.used).toBe(0);
  expect(fileRecord.resetAt).toBe(resetAt);
});
