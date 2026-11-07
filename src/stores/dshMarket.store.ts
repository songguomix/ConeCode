import { create } from 'zustand';
import type {
  CatalogQuery,
  MarketEvent,
  MarketPlugin,
  MarketSnapshot,
  MarketSource,
  MarketVersion,
  PluginDetail,
} from '../core/dsh-market/types';

type Tab = 'discover' | 'installed' | 'sources';

interface DshMarketStore {
  open: boolean;
  tab: Tab;
  snapshot: MarketSnapshot | null;
  detail: PluginDetail | null;
  loading: boolean;
  detailLoading: boolean;
  error: string | null;
  notice: string | null;
  query: string;
  category: CatalogQuery['category'];
  label: string | null;
  sort: NonNullable<CatalogQuery['sort']>;
  page: number;
  compatibleOnly: boolean;
  selectedPluginId: string | null;
  operationLog: string | null;
  logs: { path: string; text: string; truncated: boolean } | null;
  localPreview: { plugin: MarketPlugin; version: MarketVersion; warnings: string[] } | null;
  sourceBusy: string | null;
  subscribed: boolean;

  initialize: () => Promise<void>;
  openPanel: () => Promise<void>;
  closePanel: () => void;
  setTab: (tab: Tab) => void;
  setQuery: (query: string) => void;
  setCategory: (category: CatalogQuery['category']) => void;
  setLabel: (label: string | null) => void;
  setSort: (sort: NonNullable<CatalogQuery['sort']>) => void;
  setPage: (page: number) => void;
  setCompatibleOnly: (value: boolean) => void;
  refresh: () => Promise<void>;
  selectPlugin: (pluginId: string, version?: string) => Promise<void>;
  clearSelection: () => void;
  install: (pluginId: string, version?: string, acceptRisk?: boolean, allowScripts?: boolean) => Promise<void>;
  update: (pluginId: string, version: string) => Promise<void>;
  rollback: (pluginId: string, version?: string) => Promise<void>;
  uninstall: (pluginId: string, deleteData: boolean) => Promise<void>;
  setEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  saveConfig: (pluginId: string, configs: Record<string, unknown>) => Promise<void>;
  cancel: (requestId: string) => Promise<void>;
  loadLogs: (pluginId: string) => Promise<void>;
  refreshSources: (sourceId?: string) => Promise<void>;
  addRemoteSource: (url: string, title?: string) => Promise<void>;
  addLocalSource: () => Promise<void>;
  removeSource: (sourceId: string) => Promise<void>;
  inspectLocal: () => Promise<void>;
  installLocal: (acceptRisk?: boolean) => Promise<void>;
  installRepository: (input: string, ref?: string, subdir?: string, acceptRisk?: boolean, allowScripts?: boolean) => Promise<void>;
  clearLocalPreview: () => void;
  switchProfile: (profileId: string) => Promise<void>;
  createProfile: (profileId: string, name?: string) => Promise<void>;
  restartRuntime: () => Promise<void>;
  invokeTool: (pluginId: string, toolName: string, args: unknown) => Promise<string>;
  invokeCommand: (pluginId: string, commandName: string, rawInput: string) => Promise<string>;
  revealPath: (target: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  pushNotice: (message: string | null) => void;
  clearError: () => void;
}

let subscribed = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function api() {
  const bridge = (window as any).electronAPI?.dshMarket;
  if (!bridge) throw new Error('DSH plugin market requires the Electron desktop runtime.');
  return bridge;
}

async function refreshWorkspaceTools(): Promise<void> {
  try {
    const { useWorkspaceStore } = await import('./workspace.store');
    const rootPath = useWorkspaceStore.getState().rootPath || undefined;
    const tools = await (window as any).electronAPI?.mcp?.reload?.(rootPath);
    if (Array.isArray(tools)) useWorkspaceStore.setState({ mcpTools: tools });
  } catch {
    // A closed workspace is not an error.
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': /, '');
  return String(error);
}

export const useDshMarketStore = create<DshMarketStore>((set, get) => {
  const query = (): CatalogQuery => ({
    query: get().query,
    category: get().category || 'all',
    label: get().label || undefined,
    sort: get().sort,
    page: get().page,
    pageSize: 12,
    compatibleOnly: get().compatibleOnly,
  });

  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void get().refresh();
    }, 180);
  };

  const subscribe = () => {
    if (subscribed) return;
    const bridge = (window as any).electronAPI?.dshMarket;
    if (!bridge?.onEvent) return;
    subscribed = true;
    bridge.onEvent((event: MarketEvent) => {
      if (event.type === 'log' && event.message) {
        set((state) => ({
          operationLog: `${state.operationLog || ''}${event.message}\n`.slice(-12000),
        }));
        return;
      }
      if (event.message) {
        set({ notice: event.message });
        if (event.level === 'error') set({ error: event.message });
      }
      if (event.type === 'installed' || event.type === 'sources' || event.type === 'runtime' || event.type === 'operation') {
        scheduleRefresh();
      }
      if (event.type === 'installed') void refreshWorkspaceTools();
    });
  };

  const run = async <T>(work: () => Promise<T>, options: { refresh?: boolean; notice?: string } = {}): Promise<T> => {
    set({ error: null, notice: null });
    try {
      const result = await work();
      if (options.refresh !== false) await get().refresh();
      if (options.notice) set({ notice: options.notice });
      return result;
    } catch (error) {
      set({ error: messageOf(error) });
      throw error;
    }
  };

  return {
    open: false,
    tab: 'discover',
    snapshot: null,
    detail: null,
    loading: false,
    detailLoading: false,
    error: null,
    notice: null,
    query: '',
    category: 'all',
    label: null,
    sort: 'relevance',
    page: 1,
    compatibleOnly: false,
    selectedPluginId: null,
    operationLog: null,
    logs: null,
    localPreview: null,
    sourceBusy: null,
    subscribed: false,

    initialize: async () => {
      subscribe();
      set({ loading: true, error: null });
      try {
        const snapshot = await api().snapshot(query());
        set({ snapshot, loading: false, subscribed: true });
        void refreshWorkspaceTools();
      } catch (error) {
        set({ error: messageOf(error), loading: false });
      }
    },

    openPanel: async () => {
      set({ open: true });
      if (!get().snapshot) await get().initialize();
    },

    closePanel: () => set({ open: false, selectedPluginId: null, detail: null, localPreview: null }),

    setTab: (tab) => {
      set({ tab, selectedPluginId: null, detail: null });
      if (tab !== 'discover') void get().refresh();
    },

    setQuery: (value) => {
      set({ query: value, page: 1 });
      scheduleRefresh();
    },

    setCategory: (category) => {
      set({ category, label: null, page: 1 });
      scheduleRefresh();
    },

    setLabel: (label) => {
      set((state) => ({ label: state.label === label ? null : label, page: 1 }));
      scheduleRefresh();
    },

    setSort: (sort) => {
      set({ sort, page: 1 });
      scheduleRefresh();
    },

    setPage: (page) => {
      set({ page });
      scheduleRefresh();
    },

    setCompatibleOnly: (value) => {
      set({ compatibleOnly: value, page: 1 });
      scheduleRefresh();
    },

    refresh: async () => {
      set({ loading: true });
      try {
        const snapshot = await api().snapshot(query());
        set({ snapshot, loading: false, error: null });
      } catch (error) {
        set({ error: messageOf(error), loading: false });
      }
    },

    selectPlugin: async (pluginId, version) => {
      set({ selectedPluginId: pluginId, detailLoading: true, logs: null, operationLog: null });
      try {
        const detail = await api().detail(pluginId, version);
        set({ detail, detailLoading: false });
      } catch (error) {
        set({ error: messageOf(error), detailLoading: false });
      }
    },

    clearSelection: () => set({ selectedPluginId: null, detail: null, logs: null }),

    install: async (pluginId, version, acceptRisk, allowScripts) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      set({ operationLog: '' });
      await run(() => api().install(profileId, pluginId, version, { acceptRisk, allowScripts }), {
        notice: `Installed ${pluginId}`,
      });
      if (get().selectedPluginId) await get().selectPlugin(pluginId, version);
    },

    update: async (pluginId, version) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      set({ operationLog: '' });
      await run(() => api().install(profileId, pluginId, version), { notice: `Updated ${pluginId} to ${version}` });
      if (get().selectedPluginId) await get().selectPlugin(pluginId, version);
    },

    rollback: async (pluginId, version) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      await run(() => api().rollback(profileId, pluginId, version), { notice: `Rolled back ${pluginId}` });
      if (get().selectedPluginId) await get().selectPlugin(pluginId);
    },

    uninstall: async (pluginId, deleteData) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      await run(() => api().uninstall(profileId, pluginId, deleteData), { notice: `Uninstalled ${pluginId}` });
      set({ detail: null, selectedPluginId: null, logs: null });
    },

    setEnabled: async (pluginId, enabled) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      await run(() => api().setEnabled(profileId, pluginId, enabled), {
        notice: `${enabled ? 'Enabled' : 'Disabled'} ${pluginId}`,
      });
      if (get().selectedPluginId) await get().selectPlugin(pluginId);
    },

    saveConfig: async (pluginId, configs) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      await run(() => api().saveConfig(profileId, pluginId, configs), { notice: `Configuration saved for ${pluginId}` });
      if (get().selectedPluginId) await get().selectPlugin(pluginId);
    },

    cancel: async (requestId) => {
      await run(() => api().cancel(requestId), { notice: 'Cancellation requested' });
    },

    loadLogs: async (pluginId) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) return;
      try {
        const logs = await api().logs(profileId, pluginId);
        set({ logs });
      } catch (error) {
        set({ error: messageOf(error) });
      }
    },

    refreshSources: async (sourceId) => {
      set({ sourceBusy: sourceId || 'all' });
      try {
        const sources = await api().refreshSources(sourceId);
        set({ snapshot: get().snapshot ? { ...get().snapshot!, sources } : null, sourceBusy: null });
        await get().refresh();
      } catch (error) {
        set({ error: messageOf(error), sourceBusy: null });
      }
    },

    addRemoteSource: async (url, title) => {
      set({ sourceBusy: 'add' });
      try {
        const source: MarketSource = await api().addRemoteSource(url, title);
        await get().refresh();
        set({ sourceBusy: null, notice: `Added catalog: ${source.title}` });
      } catch (error) {
        set({ error: messageOf(error), sourceBusy: null });
      }
    },

    addLocalSource: async () => {
      set({ sourceBusy: 'add' });
      try {
        const source = await api().addLocalSource();
        await get().refresh();
        set({ sourceBusy: null, notice: source ? `Added catalog: ${source.title}` : null });
      } catch (error) {
        set({ error: messageOf(error), sourceBusy: null });
      }
    },

    removeSource: async (sourceId) => {
      await run(() => api().removeSource(sourceId), { notice: `Removed catalog ${sourceId}` });
    },

    inspectLocal: async () => {
      set({ error: null, notice: null });
      try {
        const result = await api().inspectLocal();
        if (result) set({ localPreview: result, tab: 'discover' });
      } catch (error) {
        set({ error: messageOf(error) });
      }
    },

    installRepository: async (input, ref, subdir, acceptRisk, allowScripts) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      set({ operationLog: '' });
      await run(() => api().installRepository(profileId, input, ref, subdir, { acceptRisk, allowScripts }), {
        notice: `Installed repository ${input}`,
      });
      set({ tab: 'installed' });
    },

    installLocal: async (acceptRisk) => {
      const profileId = get().snapshot?.profile.id;
      const preview = get().localPreview;
      if (!profileId || !preview) throw new Error('No local plugin selected');
      const directory = preview.version.source.path;
      if (!directory) throw new Error('Local source path is missing');
      await run(() => api().installLocal(profileId, directory, { acceptRisk }), {
        notice: `Installed local plugin ${preview.plugin.name}`,
      });
      set({ localPreview: null });
    },

    clearLocalPreview: () => set({ localPreview: null }),

    switchProfile: async (profileId) => {
      await run(() => api().switchProfile(profileId), { notice: `Switched to profile ${profileId}` });
      set({ detail: null, selectedPluginId: null });
      void refreshWorkspaceTools();
    },

    createProfile: async (profileId, name) => {
      await run(() => api().createProfile(profileId, name), { notice: `Created profile ${profileId}` });
    },

    restartRuntime: async () => {
      await run(() => api().restartRuntime(), { notice: 'DSH runtime restarted' });
    },

    invokeTool: async (pluginId, toolName, args) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      const result = await api().invokeTool(profileId, pluginId, toolName, args);
      if (!result.ok) throw new Error(result.error || 'Tool execution failed');
      return result.rendered || JSON.stringify(result.value, null, 2);
    },

    invokeCommand: async (pluginId, commandName, rawInput) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      const result = await api().invokeCommand(profileId, pluginId, commandName, rawInput);
      if (!result.ok) throw new Error(result.error || 'Command execution failed');
      return result.rendered || JSON.stringify(result.value, null, 2);
    },

    revealPath: async (target) => {
      try { await api().revealPath(target); } catch (error) { set({ error: messageOf(error) }); }
    },

    openExternal: async (url) => {
      try { await api().openExternal(url); } catch (error) { set({ error: messageOf(error) }); }
    },

    pushNotice: (message) => set({ notice: message }),
    clearError: () => set({ error: null }),
  };
});
