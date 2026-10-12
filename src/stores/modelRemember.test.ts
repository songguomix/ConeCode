import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIModel } from '../types';
import { useModelStore } from './model.store';

const model = (providerId: string, id: string): AIModel => ({
  id,
  name: id,
  providerId,
  supportsText: true,
  supportsVision: false,
  supportsImageGeneration: false,
  supportsAudioInput: false,
  supportsAudioOutput: false,
  supportsFunctionCalling: true,
  supportsReasoning: false,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  enabled: true,
});

const MODELS = [model('p1', 'm1'), model('p1', 'm2')];

beforeEach(() => {
  localStorage.clear();
  (globalThis as any).window = {
    electronAPI: {
      provider: { list: vi.fn(async () => [{ id: 'p1', name: 'P1', enabled: true }]) },
      model: { list: vi.fn(async () => MODELS) },
      recent: { list: vi.fn(async () => []), add: vi.fn(async (id: string) => [id]) },
      favorite: { list: vi.fn(async () => []), toggle: vi.fn(async (id: string) => [id]) },
    },
  };
  useModelStore.setState({
    models: new Map([['p1', MODELS]]),
    selectedModelId: null,
    selectedProviderId: null,
    favorites: [],
    recentModels: [],
    reasoningOverrides: [],
    limitOverrides: {},
    loading: false,
  });
});

describe('last model memory', () => {
  it('persists the pick to localStorage', () => {
    useModelStore.getState().selectModel('m2', 'p1', false);
    expect(JSON.parse(localStorage.getItem('conecode.lastModel') || '{}')).toEqual({
      providerId: 'p1',
      modelId: 'm2',
    });
  });

  it('restores the saved model after a fresh fetch', async () => {
    localStorage.setItem('conecode.lastModel', JSON.stringify({ providerId: 'p1', modelId: 'm2' }));
    useModelStore.setState({ models: new Map(), selectedModelId: null, selectedProviderId: null });
    await useModelStore.getState().fetchAllModels();
    expect(useModelStore.getState().getSelectedModel()?.id).toBe('m2');
  });

  it('does not restore a model that no longer exists, nor steal a live pick', async () => {
    localStorage.setItem('conecode.lastModel', JSON.stringify({ providerId: 'p1', modelId: 'gone' }));
    await useModelStore.getState().fetchAllModels();
    expect(useModelStore.getState().getSelectedModel()).toBeNull();

    useModelStore.getState().selectModel('m1', 'p1', false);
    localStorage.setItem('conecode.lastModel', JSON.stringify({ providerId: 'p1', modelId: 'm2' }));
    await useModelStore.getState().fetchAllModels();
    expect(useModelStore.getState().getSelectedModel()?.id).toBe('m1');
  });
});
