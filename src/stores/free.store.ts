import { create } from 'zustand';
import type { FreeStatus } from '../core/providers/free.adapter';
import { FREE_PROVIDER_ID } from '../core/providers/free.adapter';
import { useModelStore } from './model.store';
import {
  FREE_WEEKLY_TOKEN_LIMIT,
  FREE_WEEKLY_LIMIT,
  WEEKLY_LIMIT,
  FREE_WEEKLY_CAP,
  FREE_WEEKLY_TOKEN_CAP,
  WEEKLY_TOKEN_LIMIT,
  loadFreeWeeklyUsage,
  recordFreeUsage as recordFreeUsageImpl,
  resetFreeWeeklyUsage as resetFreeWeeklyUsageImpl,
  applyFreeUsageReset,
} from '../core/providers/freeUsage';

interface FreeStore {
  status: FreeStatus | null;
  loading: boolean;
  error: string | null;
  weeklyUsed: number;
  weeklyLimit: number;
  weeklyUsage: { used: number; limit: number };
  usage: { used: number; limit: number };
  recordUsage: (tokens: number) => void;
  recordFreeUsage: (tokens: number) => void;
  addUsage: (tokens: number) => void;
  resetUsage: () => void;
  resetWeeklyUsage: () => void;
  refresh: () => Promise<void>;
}

export const useFreeStore = create<FreeStore>((set, get) => ({
  status: null,
  loading: false,
  error: null,
  weeklyUsed: loadFreeWeeklyUsage().used,
  weeklyLimit: FREE_WEEKLY_TOKEN_LIMIT,
  weeklyUsage: { used: loadFreeWeeklyUsage().used, limit: FREE_WEEKLY_TOKEN_LIMIT },
  usage: { used: loadFreeWeeklyUsage().used, limit: FREE_WEEKLY_TOKEN_LIMIT },
  recordUsage: (tokens: number) => {
    const used = recordFreeUsageImpl(tokens);
    set({ weeklyUsed: used, weeklyLimit: FREE_WEEKLY_TOKEN_LIMIT, weeklyUsage: { used, limit: FREE_WEEKLY_TOKEN_LIMIT }, usage: { used, limit: FREE_WEEKLY_TOKEN_LIMIT } });
  },
  recordFreeUsage: (tokens: number) => {
    const used = recordFreeUsageImpl(tokens);
    set({ weeklyUsed: used, weeklyLimit: FREE_WEEKLY_TOKEN_LIMIT, weeklyUsage: { used, limit: FREE_WEEKLY_TOKEN_LIMIT }, usage: { used, limit: FREE_WEEKLY_TOKEN_LIMIT } });
  },
  addUsage: (tokens: number) => {
    const used = recordFreeUsageImpl(tokens);
    set({ weeklyUsed: used, weeklyLimit: FREE_WEEKLY_TOKEN_LIMIT, weeklyUsage: { used, limit: FREE_WEEKLY_TOKEN_LIMIT }, usage: { used, limit: FREE_WEEKLY_TOKEN_LIMIT } });
  },
  resetUsage: () => {
    resetFreeWeeklyUsageImpl();
    set({ weeklyUsed: 0, weeklyLimit: FREE_WEEKLY_TOKEN_LIMIT, weeklyUsage: { used: 0, limit: FREE_WEEKLY_TOKEN_LIMIT }, usage: { used: 0, limit: FREE_WEEKLY_TOKEN_LIMIT } });
  },
  resetWeeklyUsage: () => {
    resetFreeWeeklyUsageImpl();
    set({ weeklyUsed: 0, weeklyLimit: FREE_WEEKLY_TOKEN_LIMIT, weeklyUsage: { used: 0, limit: FREE_WEEKLY_TOKEN_LIMIT }, usage: { used: 0, limit: FREE_WEEKLY_TOKEN_LIMIT } });
  },
  refresh: async () => {
    if (get().loading || !window.electronAPI?.free) return;
    set({ loading: true });
    try {
      const status = await window.electronAPI.free.status();
      if (status?.usageResetAt) {
        const didReset = applyFreeUsageReset(status.usageResetAt);
        if (didReset) {
          set({
            weeklyUsed: 0,
            weeklyUsage: { used: 0, limit: FREE_WEEKLY_TOKEN_LIMIT },
            usage: { used: 0, limit: FREE_WEEKLY_TOKEN_LIMIT },
          });
          if (status.usage) {
            status.usage.used = 0;
            status.usage.usedTokens = 0;
            status.usage.weeklyUsed = 0;
          }
          status.usedTokens = 0;
          status.weeklyUsed = 0;
        }
      }
      const previous = get().status;
      const modelState = useModelStore.getState();
      if (!status.available) modelState.removeProvider(FREE_PROVIDER_ID);
      else if (!previous?.available || JSON.stringify(previous.models) !== JSON.stringify(status.models) || !modelState.models.has(FREE_PROVIDER_ID)) {
        await modelState.fetchModels(FREE_PROVIDER_ID);
        const updated = useModelStore.getState();
        if (updated.selectedProviderId === FREE_PROVIDER_ID && !updated.getSelectedModel()) {
          useModelStore.setState({ selectedModelId: null, selectedProviderId: null });
        }
        const models = updated.models.get(FREE_PROVIDER_ID);
        if (!useModelStore.getState().selectedModelId && models?.[0]) {
          updated.selectModel(models[0].id, FREE_PROVIDER_ID, false);
        }
      }
      set({ status, error: null });
    } catch {
      useModelStore.getState().removeProvider(FREE_PROVIDER_ID);
      set({ status: null, error: 'ConeCode Free 暂时不可用，请稍后重试。' });
    } finally { set({ loading: false }); }
  },
}));

// Re-export usage helpers so callers can import them from either the store or
// the provider module.
export {
  FREE_WEEKLY_TOKEN_LIMIT,
  FREE_WEEKLY_LIMIT,
  WEEKLY_LIMIT,
  FREE_WEEKLY_CAP,
  FREE_WEEKLY_TOKEN_CAP,
  WEEKLY_TOKEN_LIMIT,
  FREE_USAGE_STORAGE_KEY,
  loadFreeWeeklyUsage,
  saveFreeWeeklyUsage,
  getFreeWeeklyUsed,
  recordFreeUsage,
  resetFreeWeeklyUsage,
  isFreeWeeklyLimitReached,
} from '../core/providers/freeUsage';
