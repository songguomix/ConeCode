import { create } from 'zustand';
import type {
  CatalogQuery,
  MarketEvent,
  MarketSnapshot,
  PluginDetail,
  RepositoryInspection,
} from '../core/dsh-market/types';
import type { ElectronAPI } from '../types/ipc.types';

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
  compatFilter: NonNullable<CatalogQuery['compatFilter']>;
  formatFilter: NonNullable<CatalogQuery['formatFilter']>;
  selectedPluginId: string | null;
  operationLog: string | null;
  logs: { path: string; text: string; truncated: boolean } | null;
  localPreview: Awaited<ReturnType<ElectronAPI['dshMarket']['inspectLocal']>>;
  sourceBusy: string | null;
  webBusy: boolean;
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
  setCompatFilter: (value: NonNullable<CatalogQuery['compatFilter']>) => void;
  setFormatFilter: (value: NonNullable<CatalogQuery['formatFilter']>) => void;
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
  installLocal: (acceptRisk?: boolean, allowScripts?: boolean) => Promise<void>;
  installRepository: (inspection: RepositoryInspection, acceptRisk?: boolean, allowScripts?: boolean) => Promise<void>;
  clearLocalPreview: () => void;
  switchProfile: (profileId: string) => Promise<void>;
  createProfile: (profileId: string, name?: string) => Promise<void>;
  restartRuntime: () => Promise<void>;
  invokeTool: (pluginId: string, toolName: string, args: unknown, rowId?: string) => Promise<string>;
  invokeCommand: (pluginId: string, commandName: string, rawInput: string, rowId?: string) => Promise<string>;
  revealPath: (target: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  openDshWeb: (pluginName?: string, version?: string) => Promise<void>;
  pushNotice: (message: string | null) => void;
  clearError: () => void;
}

let subscribed = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function api() {
  const bridge = window.electronAPI?.dshMarket;
  if (!bridge) throw new Error('DSH plugin market requires the Electron desktop runtime.');
  return bridge;
}

async function refreshWorkspaceTools(): Promise<void> {
  try {
    const { useWorkspaceStore } = await import('./workspace.store');
    const tools = await window.electronAPI?.mcp?.list?.();
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
  let detailRequest = 0;
  let snapshotRequest = 0;
  let logsRequest = 0;
  const clearSelection = () => {
    detailRequest++;
    logsRequest++;
    set({ selectedPluginId: null, detail: null, detailLoading: false, logs: null });
  };
  const refreshSelected = async (request: number, pluginId: string, version?: string) => {
    if (request === detailRequest && get().selectedPluginId === pluginId) await get().selectPlugin(pluginId, version);
  };
  const query = (): CatalogQuery => ({
    query: get().query,
    category: get().category || 'all',
    label: get().label || undefined,
    sort: get().sort,
    page: get().page,
    pageSize: 12,
    compatibleOnly: get().compatibleOnly,
    compatFilter: get().compatFilter,
    formatFilter: get().formatFilter,
  });

  const refreshSnapshot = async () => {
    const request = ++snapshotRequest;
    set({ loading: true });
    try {
      const snapshot = await api().snapshot(query());
      if (request === snapshotRequest) set({ snapshot, page: snapshot.catalog.page, loading: false });
    } catch (error) {
      if (request === snapshotRequest) set({ error: messageOf(error), loading: false });
    }
  };

  const scheduleRefresh = (queryChanged = false) => {
    if (queryChanged) snapshotRequest++;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshSnapshot();
    }, 180);
  };

  const subscribe = () => {
    if (subscribed) return;
    const bridge = window.electronAPI?.dshMarket;
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
    compatFilter: 'all',
    formatFilter: 'all',
    selectedPluginId: null,
    operationLog: null,
    logs: null,
    localPreview: null,
    sourceBusy: null,
    webBusy: false,
    subscribed: false,

    initialize: async () => {
      subscribe();
      set({ subscribed, error: null });
      await refreshSnapshot();
      if (get().snapshot) void refreshWorkspaceTools();
    },

    openPanel: async () => {
      set({ open: true });
      await get().initialize();
    },

    closePanel: () => {
      clearSelection();
      set({ open: false, localPreview: null });
    },

    setTab: (tab) => {
      clearSelection();
      set({ tab });
      if (tab !== 'discover') void get().refresh();
    },

    setQuery: (value) => {
      set({ query: value, page: 1 });
      scheduleRefresh(true);
    },

    setCategory: (category) => {
      set({ category, label: null, page: 1 });
      scheduleRefresh(true);
    },

    setLabel: (label) => {
      set((state) => ({ label: state.label === label ? null : label, page: 1 }));
      scheduleRefresh(true);
    },

    setSort: (sort) => {
      set({ sort, page: 1 });
      scheduleRefresh(true);
    },

    setPage: (page) => {
      set({ page });
      scheduleRefresh(true);
    },

    setCompatibleOnly: (value) => {
      set({ compatibleOnly: value, page: 1 });
      scheduleRefresh(true);
    },

    setCompatFilter: (value) => {
      set({ compatFilter: value, page: 1 });
      scheduleRefresh(true);
    },

    setFormatFilter: (value) => {
      set({ formatFilter: value, page: 1 });
      scheduleRefresh(true);
    },

    refresh: async () => {
      set({ error: null });
      await refreshSnapshot();
    },

    selectPlugin: async (pluginId, version) => {
      const request = ++detailRequest;
      set({ selectedPluginId: pluginId, detail: null, detailLoading: true, logs: null, operationLog: null, error: null });
      try {
        const detail = await api().detail(pluginId, version);
        if (request === detailRequest) set({ detail, detailLoading: false });
      } catch (error) {
        if (request === detailRequest) set({ error: messageOf(error), detailLoading: false });
      }
    },

    clearSelection,

    install: async (pluginId, version, acceptRisk, allowScripts) => {
      const selection = detailRequest;
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      set({ operationLog: '' });
      await run(() => api().install(profileId, pluginId, version, { acceptRisk, allowScripts }), {
        notice: `Installed ${pluginId}`,
      });
      await refreshSelected(selection, pluginId, version);
    },

    update: async (pluginId, version) => {
      const selection = detailRequest;
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      set({ operationLog: '' });
      await run(() => api().install(profileId, pluginId, version), { notice: `Updated ${pluginId} to ${version}` });
      await refreshSelected(selection, pluginId, version);
    },

    rollback: async (pluginId, version) => {
      const selection = detailRequest;
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      await run(() => api().rollback(profileId, pluginId, version), { notice: `Rolled back ${pluginId}` });
      await refreshSelected(selection, pluginId);
    },

    uninstall: async (pluginId, deleteData) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      await run(() => api().uninstall(profileId, pluginId, deleteData), { notice: `Uninstalled ${pluginId}` });
      if (get().selectedPluginId === pluginId) clearSelection();
    },

    setEnabled: async (pluginId, enabled) => {
      const selection = detailRequest;
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      await run(() => api().setEnabled(profileId, pluginId, enabled), {
        notice: `${enabled ? 'Enabled' : 'Disabled'} ${pluginId}`,
      });
      await refreshSelected(selection, pluginId);
    },

    saveConfig: async (pluginId, configs) => {
      const selection = detailRequest;
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      await run(() => api().saveConfig(profileId, pluginId, configs), { notice: `Configuration saved for ${pluginId}` });
      await refreshSelected(selection, pluginId);
    },

    cancel: async (requestId) => {
      await run(() => api().cancel(requestId), { notice: 'Cancellation requested' });
    },

    loadLogs: async (pluginId) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) return;
      const request = ++logsRequest;
      set({ logs: null });
      try {
        const logs = await api().logs(profileId, pluginId);
        if (request === logsRequest) set({ logs });
      } catch (error) {
        if (request === logsRequest) set({ error: messageOf(error) });
      }
    },

    refreshSources: async (sourceId) => {
      set({ sourceBusy: sourceId || 'all' });
      try {
        await api().refreshSources(sourceId);
        await get().refresh();
        set({ sourceBusy: null });
      } catch (error) {
        set({ error: messageOf(error), sourceBusy: null });
      }
    },

    addRemoteSource: async (url, title) => {
      set({ sourceBusy: 'add' });
      try {
        const source = await api().addRemoteSource(url, title);
        await get().refresh();
        set({ sourceBusy: null, notice: `Added catalog: ${source.title}` });
      } catch (error) {
        set({ error: messageOf(error), sourceBusy: null });
        throw error;
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

    installRepository: async ({ url, commit, subdir }, acceptRisk, allowScripts) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      set({ operationLog: '' });
      await run(() => api().installRepository(profileId, url, commit, subdir, { acceptRisk, allowScripts }), {
        notice: `Installed repository ${url}`,
      });
      set({ tab: 'installed' });
    },

    installLocal: async (acceptRisk, allowScripts) => {
      const profileId = get().snapshot?.profile.id;
      const preview = get().localPreview;
      if (!profileId || !preview) throw new Error('No local plugin selected');
      const directory = preview.version.source.path;
      if (!directory) throw new Error('Local source path is missing');
      await run(() => api().installLocal(profileId, directory, { acceptRisk, allowScripts }), {
        notice: `Installed local plugin ${preview.plugin.name}`,
      });
      set({ localPreview: null, tab: 'installed' });
    },

    clearLocalPreview: () => set({ localPreview: null }),

    switchProfile: async (profileId) => {
      await run(() => api().switchProfile(profileId), { notice: `Switched to profile ${profileId}` });
      clearSelection();
      void refreshWorkspaceTools();
    },

    createProfile: async (profileId, name) => {
      await run(() => api().createProfile(profileId, name), { notice: `Created profile ${profileId}` });
    },

    restartRuntime: async () => {
      await run(() => api().restartRuntime(), { notice: 'DSH runtime restarted' });
    },

    invokeTool: async (pluginId, toolName, args, rowId) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      const result = await api().invokeTool(profileId, pluginId, toolName, args, rowId);
      if (!result.ok) throw new Error(result.error || 'Tool execution failed');
      return result.rendered ?? JSON.stringify(result.value, null, 2) ?? '';
    },

    invokeCommand: async (pluginId, commandName, rawInput, rowId) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId) throw new Error('No active profile');
      const result = await api().invokeCommand(profileId, pluginId, commandName, rawInput, rowId);
      if (!result.ok) throw new Error(result.error || 'Command execution failed');
      return result.rendered ?? JSON.stringify(result.value, null, 2) ?? '';
    },

    revealPath: async (target) => {
      try { await api().revealPath(target); } catch (error) { set({ error: messageOf(error) }); }
    },

    openExternal: async (url) => {
      try { await api().openExternal(url); } catch (error) { set({ error: messageOf(error) }); }
    },

    openDshWeb: async (pluginName, version) => {
      const profileId = get().snapshot?.profile.id;
      if (!profileId || get().webBusy) return;
      set({ webBusy: true, error: null });
      try {
        await api().openDshWeb(profileId, pluginName, version);
      } catch (error) {
        set({ error: messageOf(error) });
      } finally {
        set({ webBusy: false });
      }
    },

    pushNotice: (message) => set({ notice: message }),
    clearError: () => set({ error: null }),
  };
});
