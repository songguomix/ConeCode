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
