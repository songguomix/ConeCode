import { create } from 'zustand';
import type { PreviewPlan, PreviewStatus, PreviewLog } from '../types/ipc.types';

// Renderer-side state for the built-in browser: the dev server main is running
// (see electron/preview/devserver.ts) plus the browser's own tabs. It lives in a
// store rather than in the panel so the sidebar can show a live dot, and so
// closing the panel doesn't tear down the server or lose the open tabs.

/**
 * One line of preview output. Dev-server stdout/stderr and messages the
 * previewed page logged to its own console share a stream so the drawer reads
 * as a single timeline; `stream` keeps them visually distinguishable.
 */
export interface PreviewLogEntry {
  stream: 'stdout' | 'stderr' | 'system' | 'console';
  data: string;
  level?: 'info' | 'warn' | 'error';
}

/**
 * A tab in the built-in browser. `mountUrl` is the address its <webview> element
 * was created with and only changes when the element must be replaced; `url` is
 * where the tab actually is. Both null = the new-tab page.
 */
export interface BrowserTab {
  id: string;
  mountUrl: string | null;
  url: string | null;
  title: string | null;
}

export type DevicePreset = 'desktop' | 'tablet' | 'mobile';

/** Viewport the page is rendered at. `null` width = fill the panel. */
export const DEVICE_SIZES: Record<DevicePreset, { width: number | null; height: number | null }> = {
  desktop: { width: null, height: null },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
};

/** Keep the log bounded — a chatty dev server would otherwise grow forever. */
const MAX_LOG = 400;

let tabSeq = 0;
const newTab = (url: string | null = null): BrowserTab => ({
  id: `tab-${++tabSeq}`,
  mountUrl: url,
  url,
  title: null,
});

interface PreviewStore {
  state: PreviewStatus['state'];
  url: string | null;
  plan: PreviewPlan | null;
  error: string | null;
  logs: PreviewLogEntry[];
  device: DevicePreset;
  /** Bumped to ask the active tab's webview to reload (watcher / reload button). */
  reloadNonce: number;
  /** Console errors the embedded page reported, for the log drawer's badge. */
  pageErrors: number;
  subscribed: boolean;

  tabs: BrowserTab[];
  activeTabId: string;
  /** Element picker armed — the next click in the page is captured, not delivered. */
  picking: boolean;

  detect: (cwd: string) => Promise<PreviewPlan | null>;
  start: (cwd: string, command?: string | null) => Promise<void>;
  stop: () => Promise<void>;
  restart: (cwd: string) => Promise<void>;
  setDevice: (device: DevicePreset) => void;
  requestReload: () => void;
  clearLogs: () => void;
  appendLog: (entry: PreviewLogEntry) => void;
  setPicking: (picking: boolean) => void;

  openTab: (url?: string | null) => string;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  /** Point a tab at a new address. Remounts only when it has no element yet. */
  navigateTab: (id: string, url: string) => void;
  /** Adopt where the page actually went (did-navigate). */
  noteTabUrl: (id: string, url: string) => void;
  setTabTitle: (id: string, title: string) => void;
  /** Attach the main-process listeners once, at app start. */
  subscribe: () => void;
}

const api = () => (window as any).electronAPI?.preview;
const firstTab = newTab();

export const usePreviewStore = create<PreviewStore>((set, get) => ({
  state: 'idle',
  url: null,
  plan: null,
  error: null,
  logs: [],
  device: 'desktop',
  reloadNonce: 0,
  pageErrors: 0,
  subscribed: false,

  tabs: [firstTab],
  activeTabId: firstTab.id,
  picking: false,

  detect: async (cwd: string) => {
    const plan = (await api()?.detect(cwd)) ?? null;
    if (get().state === 'idle') set({ plan });
    return plan;
  },

  start: async (cwd: string, command?: string | null) => {
    if (!api()) return;
    set({ logs: [], pageErrors: 0, error: null, state: 'starting' });
    applyStatus(set, await api().start({ cwd, command: command || null }));
  },

  stop: async () => {
    if (!api()) return;
    applyStatus(set, await api().stop());
  },

  restart: async (cwd: string) => {
    // A hand-typed command is kept across restarts; a detected one is re-detected.
    const { plan } = get();
    await get().start(cwd, plan?.mode === 'command' ? plan.command : null);
  },

  setDevice: (device) => set({ device }),
  requestReload: () => set((s) => ({ reloadNonce: s.reloadNonce + 1, pageErrors: 0 })),
  clearLogs: () => set({ logs: [], pageErrors: 0 }),
  setPicking: (picking) => set({ picking }),

  appendLog: (entry) => set((s) => ({
    logs: [...s.logs, entry].slice(-MAX_LOG),
    pageErrors: entry.level === 'error' ? s.pageErrors + 1 : s.pageErrors,
  })),

  openTab: (url = null) => {
    const tab = newTab(url);
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  closeTab: (id) => set((s) => {
    const index = s.tabs.findIndex((t) => t.id === id);
    if (index < 0) return {};
    const tabs = s.tabs.filter((t) => t.id !== id);
    // Never leave the browser with no tab — closing the last one gives a blank one.
    if (tabs.length === 0) {
      const tab = newTab();
      return { tabs: [tab], activeTabId: tab.id };
    }
    const activeTabId = s.activeTabId === id
      ? tabs[Math.min(index, tabs.length - 1)].id
      : s.activeTabId;
    return { tabs, activeTabId };
  }),

  selectTab: (id) => set({ activeTabId: id, picking: false }),

  navigateTab: (id, url) => set((s) => ({
    tabs: s.tabs.map((t) => (
      t.id === id
        // No element yet (new-tab page): mounting one at this address is the
        // navigation. Otherwise the panel calls loadURL and keeps the history.
        ? { ...t, url, mountUrl: t.mountUrl ?? url }
        : t
    )),
  })),

  noteTabUrl: (id, url) => set((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, url } : t)),
  })),

  setTabTitle: (id, title) => set((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
  })),

  subscribe: () => {
    if (get().subscribed || !api()) return;
    set({ subscribed: true });
    api().onStatus((status: PreviewStatus) => applyStatus(set, status));
    api().onLog((entry: PreviewLog) => get().appendLog(entry));
    api().onReload(() => get().requestReload());
  },
}));

type Set = (partial: Partial<PreviewStore> | ((s: PreviewStore) => Partial<PreviewStore>)) => void;

function applyStatus(set: Set, status: PreviewStatus): void {
  if (!status) return;
  set({ state: status.state, url: status.url, plan: status.plan, error: status.error });
}
