import { create } from 'zustand';
import type { AIModel } from '../types';

// Models that the user manually flagged as reasoning-capable (the 🧠 toggle).
// Persisted to localStorage and re-applied after every fetch, because each
// fetch returns fresh model objects from the provider that don't carry the
// override — without this it would silently reset on refresh/restart.
const REASONING_OVERRIDES_KEY = 'reasoningOverrides';

function loadReasoningOverrides(): string[] {
  try {
    return JSON.parse(localStorage.getItem(REASONING_OVERRIDES_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveReasoningOverrides(ids: string[]): void {
  try {
    localStorage.setItem(REASONING_OVERRIDES_KEY, JSON.stringify(ids));
  } catch {}
}

export function modelReasoningKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}

function hasReasoningOverride(overrides: string[], model: AIModel): boolean {
  // The plain model-id form is the legacy format. Read it until the next edit,
  // then migrate to provider-scoped keys so duplicate ids no longer leak.
  return overrides.includes(modelReasoningKey(model.providerId, model.id)) || overrides.includes(model.id);
}

function migrateReasoningOverrides(overrides: string[], models: AIModel[]): string[] {
  const migrated = new Set<string>();
  for (const override of overrides) {
    if (override.startsWith('[')) {
      migrated.add(override);
      continue;
    }
    const matches = models.filter((model) => model.id === override);
    if (matches.length) matches.forEach((model) => migrated.add(modelReasoningKey(model.providerId, model.id)));
    else migrated.add(override);
  }
  return [...migrated];
}

function applyReasoningOverrides(models: AIModel[], overrides: string[]): AIModel[] {
  if (!overrides.length) return models;
  return models.map((m) => (hasReasoningOverride(overrides, m) ? { ...m, userEnabledReasoning: true } : m));
}

// Manual per-model context-window / max-output overrides. The provider is part
// of the key because several OpenAI-compatible providers can expose the same
// model id with different limits.
const LIMIT_OVERRIDES_KEY = 'modelLimitOverrides';

export interface LimitOverride {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export function modelLimitKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}

function loadLimitOverrides(): Record<string, LimitOverride> {
  try {
    return JSON.parse(localStorage.getItem(LIMIT_OVERRIDES_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveLimitOverrides(o: Record<string, LimitOverride>): void {
  try {
    localStorage.setItem(LIMIT_OVERRIDES_KEY, JSON.stringify(o));
  } catch {}
}

// Idempotent: stashes the auto value on first pass, then derives the effective
// limit as override ?? auto. Re-running it (e.g. after an override is removed)
// correctly falls back to the auto value rather than a previously-overridden one.
function applyLimitOverrides(models: AIModel[], overrides: Record<string, LimitOverride>): AIModel[] {
  return models.map((m) => {
    const autoContextWindow = m.autoContextWindow ?? m.contextWindow;
    const autoMaxOutputTokens = m.autoMaxOutputTokens ?? m.maxOutputTokens;
    // Fall back to the legacy model-id-only key so existing settings continue
    // to work. The next edit migrates it to the provider-scoped key.
    const o = overrides[modelLimitKey(m.providerId, m.id)] ?? overrides[m.id];
    return {
      ...m,
      autoContextWindow,
      autoMaxOutputTokens,
      contextWindow: o?.contextWindow ?? autoContextWindow,
      maxOutputTokens: o?.maxOutputTokens ?? autoMaxOutputTokens,
    };
  });
}

function applyAllOverrides(models: AIModel[], reasoning: string[], limits: Record<string, LimitOverride>): AIModel[] {
  return applyLimitOverrides(applyReasoningOverrides(models, reasoning), limits);
}

interface ModelStore {
  models: Map<string, AIModel[]>;
  selectedModelId: string | null;
  selectedProviderId: string | null;
  favorites: string[];
  recentModels: string[];
  reasoningOverrides: string[];
  limitOverrides: Record<string, LimitOverride>;
  loading: boolean;
  fetchModels: (providerId: string) => Promise<boolean>;
  fetchAllModels: () => Promise<void>;
  selectModel: (modelId: string, providerId?: string, recordRecent?: boolean) => void;
  getSelectedModel: () => AIModel | null;
  toggleFavorite: (modelId: string) => Promise<void>;
  toggleReasoning: (providerId: string, modelId: string) => void;
  learnReasoning: (providerId: string, modelId: string) => void;
  setModelLimits: (providerId: string, modelId: string, limits: { contextWindow?: number | null; maxOutputTokens?: number | null }) => void;
  addToRecent: (modelId: string) => Promise<void>;
  searchModels: (query: string) => AIModel[];
  getModelsByProvider: (providerId: string) => AIModel[];
  removeProvider: (providerId: string) => void;
}

export const useModelStore = create<ModelStore>((set, get) => ({
  models: new Map(),
  selectedModelId: null,
  selectedProviderId: null,
  favorites: [],
  recentModels: [],
  reasoningOverrides: loadReasoningOverrides(),
  limitOverrides: loadLimitOverrides(),
  loading: false,

  fetchModels: async (providerId) => {
    // Read-only list refresh — NOT an install, so it never raises the
    // install pill or pauses the model (that gate is for real downloads).
    set({ loading: true });
    try {
      const models = await window.electronAPI.model.list(providerId);
      set((s) => {
        const newModels = new Map(s.models);
        newModels.set(providerId, applyAllOverrides(models, s.reasoningOverrides, s.limitOverrides));
        return { models: newModels, loading: false };
      });
      return true;
    } catch (error) {
      console.error(`Failed to fetch models for provider ${providerId}:`, error);
      return false;
    } finally {
      set({ loading: false });
    }
  },

  fetchAllModels: async () => {
    set({ loading: true });
    try {
      const providers = await window.electronAPI.provider.list();
      const grouped = new Map<string, AIModel[]>();

      // Provider model endpoints are independent. Loading them in parallel
      // makes startup scale with the slowest provider instead of their sum.
      const enabled = providers.filter((provider) => provider.enabled);
      const fetched = await Promise.all(enabled.map(async (provider) => {
        try {
          return [provider.id, await window.electronAPI.model.list(provider.id)] as const;
        } catch (error) {
          console.error(`Failed to fetch models for provider ${provider.name}:`, error);
          return [provider.id, [] as AIModel[]] as const;
        }
      }));
      for (const [providerId, models] of fetched) {
        if (models.length > 0) grouped.set(providerId, models);
      }

      // Favorites and recents are persisted by the main process; previously
      // they were never read back, so both sections emptied on every restart.
      const [favorites, recentModels] = await Promise.all([
        window.electronAPI.favorite?.list
          ? window.electronAPI.favorite.list().catch(() => get().favorites)
          : Promise.resolve(get().favorites),
        window.electronAPI.recent?.list
          ? window.electronAPI.recent.list().catch(() => get().recentModels)
          : Promise.resolve(get().recentModels),
      ]);

      const overrides = get().reasoningOverrides;
      const limits = get().limitOverrides;
      for (const [pid, list] of grouped) {
        grouped.set(pid, applyAllOverrides(list, overrides, limits));
      }

      set({ models: grouped, favorites, recentModels, loading: false });
    } catch (error) {
      console.error('Failed to fetch all models:', error);
    } finally {
      set({ loading: false });
    }
  },

  selectModel: (modelId, providerId, recordRecent = true) => {
    const resolvedProviderId = providerId ?? Array.from(get().models.entries())
      .find(([, list]) => list.some((m) => m.id === modelId))?.[0] ?? null;
    if (!resolvedProviderId || !get().models.get(resolvedProviderId)?.some((model) => model.id === modelId)) return;
    set({ selectedModelId: modelId, selectedProviderId: resolvedProviderId });
    if (recordRecent) void get().addToRecent(modelId).catch(() => {});
  },

  getSelectedModel: () => {
    const { selectedModelId, selectedProviderId, models } = get();
    if (!selectedModelId) return null;
    if (selectedProviderId) {
      const selected = models.get(selectedProviderId)?.find((m) => m.id === selectedModelId);
      if (selected) return selected;
      // Provider identity is part of the selection. Never silently fall over
      // to another provider that happens to expose the same model id.
      return null;
    }
    for (const list of models.values()) {
      const found = list.find((m) => m.id === selectedModelId);
      if (found) return found;
    }
    return null;
  },

  toggleFavorite: async (modelId) => {
    const favs = await window.electronAPI.favorite.toggle(modelId);
    set({ favorites: favs });
  },

  toggleReasoning: (providerId, modelId) => {
    set((s) => {
      const allModels = Array.from(s.models.values()).flat();
      const reasoningOverrides = migrateReasoningOverrides(s.reasoningOverrides, allModels);
      const key = modelReasoningKey(providerId, modelId);
      const wasOn = reasoningOverrides.includes(key);
      const nextOverrides = wasOn
        ? reasoningOverrides.filter((id) => id !== key)
        : [...reasoningOverrides, key];
      saveReasoningOverrides(nextOverrides);

      const newModels = new Map<string, AIModel[]>();
      for (const [pid, list] of s.models) {
        newModels.set(pid, list.map((m) =>
          pid === providerId && m.id === modelId ? { ...m, userEnabledReasoning: !wasOn } : m
        ));
      }
      return { models: newModels, reasoningOverrides: nextOverrides };
    });
  },

  // Called when a model's actual API response contained reasoning_content — the
  // ground-truth signal that it supports reasoning, regardless of what the
  // /models endpoint advertised. Persisted so it sticks across refresh/restart.
  learnReasoning: (providerId, modelId) => {
    const s = get();
    const allModels = Array.from(s.models.values()).flat();
    const reasoningOverrides = migrateReasoningOverrides(s.reasoningOverrides, allModels);
    const key = modelReasoningKey(providerId, modelId);
    if (reasoningOverrides.includes(key)) return;
    const nextOverrides = [...reasoningOverrides, key];
    saveReasoningOverrides(nextOverrides);

    const newModels = new Map<string, AIModel[]>();
    for (const [pid, list] of s.models) {
      newModels.set(pid, list.map((m) =>
        pid === providerId && m.id === modelId ? { ...m, userEnabledReasoning: true } : m
      ));
    }
    set({ models: newModels, reasoningOverrides: nextOverrides });
  },

  // Set or clear a manual context-window / max-output override for a model. Pass
  // a number to set, null to reset that field back to the auto value, or omit a
  // field to leave it unchanged. Persisted and re-applied to the in-memory list.
  setModelLimits: (providerId, modelId, limits) => {
    set((s) => {
      const key = modelLimitKey(providerId, modelId);
      const next: LimitOverride = { ...(s.limitOverrides[key] ?? s.limitOverrides[modelId] ?? {}) };
      if (limits.contextWindow === null) delete next.contextWindow;
      else if (typeof limits.contextWindow === 'number') next.contextWindow = limits.contextWindow;
      if (limits.maxOutputTokens === null) delete next.maxOutputTokens;
      else if (typeof limits.maxOutputTokens === 'number') next.maxOutputTokens = limits.maxOutputTokens;

      const limitOverrides = { ...s.limitOverrides };
      // Remove the legacy global key during migration so it cannot leak to a
      // same-named model belonging to another provider.
      delete limitOverrides[modelId];
      if (next.contextWindow == null && next.maxOutputTokens == null) delete limitOverrides[key];
      else limitOverrides[key] = next;
      saveLimitOverrides(limitOverrides);

      const newModels = new Map<string, AIModel[]>();
      for (const [providerId, list] of s.models) {
        newModels.set(providerId, applyLimitOverrides(list, limitOverrides));
      }
      return { models: newModels, limitOverrides };
    });
  },

  addToRecent: async (modelId) => {
    const recents = await window.electronAPI.recent.add(modelId);
    set({ recentModels: recents });
  },

  searchModels: (query) => {
    const { models } = get();
    const all = Array.from(models.values()).flat();
    if (!query) return all;
    const q = query.toLowerCase();
    return all.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  },

  getModelsByProvider: (providerId) => {
    return get().models.get(providerId) || [];
  },

  // Drop a provider's cached models (on provider delete/disable) so they don't
  // linger anywhere that reads the cache — notably the phone remote's model picker.
  removeProvider: (providerId) => {
    set((s) => {
      if (!s.models.has(providerId)) return {} as any;
      const models = new Map(s.models);
      models.delete(providerId);
      if (s.selectedProviderId === providerId) {
        return { models, selectedModelId: null, selectedProviderId: null };
      }
      const stillThere = Array.from(models.values()).flat().some((m) => m.id === s.selectedModelId);
      return {
        models,
        selectedModelId: stillThere ? s.selectedModelId : null,
        selectedProviderId: stillThere ? s.selectedProviderId : null,
      };
    });
  },
}));
