import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIModel } from '../types';
import { modelLimitKey, modelReasoningKey, useModelStore } from './model.store';

function model(providerId: string, contextWindow: number, maxOutputTokens = 8192): AIModel {
  return {
    id: 'shared-model',
    name: `${providerId} model`,
    providerId,
    supportsText: true,
    supportsVision: false,
    supportsImageGeneration: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsFunctionCalling: true,
    supportsReasoning: false,
    contextWindow,
    maxOutputTokens,
    enabled: true,
  };
}

beforeEach(() => {
  localStorage.clear();
  (globalThis as any).window = {
    electronAPI: {
      recent: { list: vi.fn(async () => []), add: vi.fn(async (id: string) => [id]) },
      favorite: { list: vi.fn(async () => []), toggle: vi.fn(async (id: string) => [id]) },
      provider: { list: vi.fn(async () => []) },
      model: { list: vi.fn() },
    },
  };
  useModelStore.setState({
    models: new Map(),
    selectedModelId: null,
    selectedProviderId: null,
    favorites: [],
    recentModels: [],
    reasoningOverrides: [],
    limitOverrides: {},
    loading: false,
  });
});

describe('model context limits', () => {
  it('selects the correct provider when model ids are duplicated', () => {
    useModelStore.setState({
      models: new Map([
        ['provider-a', [model('provider-a', 128_000)]],
        ['provider-b', [model('provider-b', 200_000)]],
      ]),
    });

    useModelStore.getState().selectModel('shared-model', 'provider-b');

    expect(useModelStore.getState().selectedProviderId).toBe('provider-b');
    expect(useModelStore.getState().getSelectedModel()?.contextWindow).toBe(200_000);
  });

  it('rejects stale provider/model selections instead of falling through to a duplicate id', () => {
    useModelStore.setState({
      models: new Map([['provider-a', [model('provider-a', 128_000)]]]),
      selectedModelId: 'shared-model',
      selectedProviderId: 'missing-provider',
    });

    expect(useModelStore.getState().getSelectedModel()).toBeNull();
    useModelStore.getState().selectModel('missing-model', 'provider-a');
    expect(useModelStore.getState().selectedProviderId).toBe('missing-provider');
  });

  it('scopes a manual limit to one provider', () => {
    useModelStore.setState({
      models: new Map([
        ['provider-a', [model('provider-a', 128_000)]],
        ['provider-b', [model('provider-b', 200_000)]],
      ]),
    });

    useModelStore.getState().setModelLimits('provider-a', 'shared-model', { contextWindow: 32_000 });

    const state = useModelStore.getState();
    expect(state.models.get('provider-a')?.[0].contextWindow).toBe(32_000);
    expect(state.models.get('provider-b')?.[0].contextWindow).toBe(200_000);
    expect(state.limitOverrides[modelLimitKey('provider-a', 'shared-model')]).toEqual({ contextWindow: 32_000 });
  });

  it('restores the API value after clearing a manual limit', () => {
    useModelStore.setState({ models: new Map([['provider-a', [model('provider-a', 128_000)]]]) });
    const store = useModelStore.getState();

    store.setModelLimits('provider-a', 'shared-model', { contextWindow: 32_000 });
    useModelStore.getState().setModelLimits('provider-a', 'shared-model', { contextWindow: null });

    expect(useModelStore.getState().models.get('provider-a')?.[0].contextWindow).toBe(128_000);
    expect(useModelStore.getState().limitOverrides).toEqual({});
  });

  it('keeps a manual value while refreshing, then exposes the new API value on reset', async () => {
    useModelStore.setState({ models: new Map([['provider-a', [model('provider-a', 128_000)]]]) });
    useModelStore.getState().setModelLimits('provider-a', 'shared-model', { contextWindow: 32_000 });
    (window.electronAPI.model.list as any).mockResolvedValue([model('provider-a', 256_000)]);

    expect(await useModelStore.getState().fetchModels('provider-a')).toBe(true);
    expect(useModelStore.getState().models.get('provider-a')?.[0]).toMatchObject({
      contextWindow: 32_000,
      autoContextWindow: 256_000,
    });

    useModelStore.getState().setModelLimits('provider-a', 'shared-model', { contextWindow: null });
    expect(useModelStore.getState().models.get('provider-a')?.[0].contextWindow).toBe(256_000);
  });

  it('loads every provider in one refresh and restores favorites and recents', async () => {
    (window.electronAPI.provider.list as any).mockResolvedValue([
      { id: 'provider-a', name: 'A', enabled: true },
      { id: 'provider-b', name: 'B', enabled: true },
    ]);
    (window.electronAPI.favorite.list as any).mockResolvedValue(['a-1']);
    (window.electronAPI.recent.list as any).mockResolvedValue(['b-2']);
    (window.electronAPI.model.list as any).mockImplementation(async (providerId: string) =>
      providerId === 'provider-a'
        ? [{ ...model('provider-a', 128_000), id: 'a-1' }, { ...model('provider-a', 64_000), id: 'a-2' }]
        : [{ ...model('provider-b', 200_000), id: 'b-1' }, { ...model('provider-b', 96_000), id: 'b-2' }],
    );

    await useModelStore.getState().fetchAllModels();

    const state = useModelStore.getState();
    expect(state.models.get('provider-a')).toHaveLength(2);
    expect(state.models.get('provider-b')).toHaveLength(2);
    expect(state.favorites).toEqual(['a-1']);
    expect(state.recentModels).toEqual(['b-2']);
  });

  it('scopes learned reasoning capability to one provider', () => {
    useModelStore.setState({
      models: new Map([
        ['provider-a', [model('provider-a', 128_000)]],
        ['provider-b', [model('provider-b', 200_000)]],
      ]),
    });

    useModelStore.getState().learnReasoning('provider-a', 'shared-model');

    const state = useModelStore.getState();
    expect(state.models.get('provider-a')?.[0].userEnabledReasoning).toBe(true);
    expect(state.models.get('provider-b')?.[0].userEnabledReasoning).not.toBe(true);
    expect(state.reasoningOverrides).toEqual([modelReasoningKey('provider-a', 'shared-model')]);
  });
});
