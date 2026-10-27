import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFreeStore } from './free.store';
import { useModelStore } from './model.store';
import { FREE_PROVIDER_ID } from '../core/providers/free.adapter';
import type { AIModel } from '../types';

const model = (id: string): AIModel => ({ id, name: id, providerId: FREE_PROVIDER_ID, supportsText: true, supportsVision: false, supportsFunctionCalling: true, supportsReasoning: false, contextWindow: 128000, maxOutputTokens: 8192, enabled: true } as AIModel);
beforeEach(() => {
  useFreeStore.setState({ status: null, loading: false, error: null });
  useModelStore.setState({ models: new Map(), selectedModelId: null, selectedProviderId: null });
});
afterEach(() => vi.unstubAllGlobals());
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

it('keeps the durable weekly count across refresh — a restart must not reset it', async () => {
  // Models the main-process file store: hydrate hands back last session's
  // count, sync returns it unchanged, record accumulates in the file.
  let fileUsed = 555;
  vi.stubGlobal('window', { electronAPI: { free: {
    status: async () => ({ available: true, mode: 'on', startsAt: null, endsAt: null, models: [model('first')] }),
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
    status: async () => ({
      available: true, mode: 'on', startsAt: null, endsAt: null, models: [],
      usage: { used: 999, limit: 2000000000 },
      usedTokens: 999, weeklyUsed: 999,
      usageResetAt: '2026-10-26T00:00:00Z',
    }),
    usageHydrate: async () => ({ weekStart: 1, used: 999, resetAt: null }),
    usageSync: async () => ({ record: { weekStart: 1, used: 0, resetAt: '2026-10-26T00:00:00.000Z' }, changed: true }),
  } } });

  await useFreeStore.getState().refresh();
  expect(useFreeStore.getState().weeklyUsed).toBe(0);
  // The stale server-reported usage is zeroed for display too.
  expect(useFreeStore.getState().status?.weeklyUsed).toBe(0);
  expect(useFreeStore.getState().status?.usage?.used).toBe(0);
});
