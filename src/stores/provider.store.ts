import { create } from 'zustand';
import type { ProviderConfig } from '../types';

interface ProviderStore {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  loading: boolean;
  error: string | null;
  fetchProviders: () => Promise<void>;
  addProvider: (config: Omit<ProviderConfig, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateProvider: (id: string, config: Partial<ProviderConfig>) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  toggleProvider: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
}

export const useProviderStore = create<ProviderStore>((set, get) => ({
  providers: [],
  activeProviderId: null,
  loading: false,
  error: null,

  fetchProviders: async () => {
    set({ loading: true, error: null });
    try {
      const providers = await window.electronAPI.provider.list();
      set({ providers, loading: false });
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  addProvider: async (config) => {
    try {
      const provider = await window.electronAPI.provider.create(config);
      set((s) => ({ providers: [...s.providers, provider] }));
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  updateProvider: async (id, config) => {
    try {
      const provider = await window.electronAPI.provider.update(id, config);
      // The main process returns null when the id no longer exists — keep the
      // current entry rather than punching a null into the list.
      set((s) => ({ providers: s.providers.map((p) => (p.id === id && provider ? provider : p)) }));
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  deleteProvider: async (id) => {
    try {
      await window.electronAPI.provider.delete(id);
      set((s) => ({ providers: s.providers.filter((p) => p.id !== id) }));
      // Drop its cached models so deleted models don't linger (e.g. in the phone picker).
      const { useModelStore } = await import('./model.store');
      useModelStore.getState().removeProvider(id);
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  toggleProvider: async (id) => {
    const provider = get().providers.find((p) => p.id === id);
    if (provider) {
      const enabling = !provider.enabled;
      await get().updateProvider(id, { enabled: enabling });
      // A disabled provider's models should disappear from the cache too.
      if (!enabling) {
        const { useModelStore } = await import('./model.store');
        useModelStore.getState().removeProvider(id);
      }
    }
  },

  setActive: (id) => set({ activeProviderId: id }),
}));
