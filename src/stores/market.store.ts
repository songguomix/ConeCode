import { create } from 'zustand';

// The GitHub plugin's state. Its whole job is to push the *open project* to a
// GitHub repo: it stores where to push and the token to push with, reads the
// project's git state, and runs one commit+push. No skills, no SKILL.md — the
// chat model only ever asks this store to push; it never touches git itself.
const REPO_KEY = 'conecode.pluginRepo';
const TOKEN_KEY = 'conecode.pluginToken';

/** Minimal git state of the open project, for the plugin view. */
export interface RepoStatus {
  isRepo: boolean;
  branch: string | null;
  dirty: number;
}

export interface RepoPushResult {
  ok: boolean;
  message: string;
}

interface MarketStore {
  /** "owner/repo" the open project is pushed to. */
  repo: string;
  tokenSet: boolean;
  /** Git state of the open project; null until refreshed with a folder open. */
  status: RepoStatus | null;
  refreshing: boolean;
  pushing: boolean;
  /** When the last successful push happened (for the view). */
  lastPushAt: number | null;
  /** Last push outcome — kept so the view can show exactly what the model saw. */
  result: RepoPushResult | null;
  setRepo: (repo: string) => void;
  /** Persist a token (or null to forget it). The value never enters state. */
  setToken: (token: string | null) => void;
  /** Read the open project's git state (branch, uncommitted count). */
  refresh: () => Promise<void>;
  /**
   * Commit whatever is uncommitted in the open project and push the current
   * branch to the configured repo. Runs through the main process; the token, if
   * any, authenticates the push without being stored in the git config.
   */
  pushRepo: (message?: string) => Promise<RepoPushResult>;
}

function loadRepo(): string {
  try {
    return localStorage.getItem(REPO_KEY) || '';
  } catch {
    return '';
  }
}

function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

/** Accept "owner/repo" or a github.com URL, reject everything else. */
export function normalizeRepo(input: string): string | null {
  const t = input.trim().replace(/\/+$/, '');
  const m = t.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

async function openRoot(): Promise<string | null> {
  const { useWorkspaceStore } = await import('./workspace.store');
  return useWorkspaceStore.getState().rootPath || null;
}

export const useMarketStore = create<MarketStore>((set, get) => ({
  repo: loadRepo(),
  tokenSet: !!loadToken(),
  status: null,
  refreshing: false,
  pushing: false,
  lastPushAt: null,
  result: null,

  setRepo: (repo) => {
    try {
      localStorage.setItem(REPO_KEY, repo);
    } catch {}
    set({ repo });
  },

  setToken: (token) => {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {}
    set({ tokenSet: !!token });
  },

  refresh: async () => {
    const root = await openRoot();
    set({ refreshing: true });
    try {
      if (!root) {
        set({ status: { isRepo: false, branch: null, dirty: 0 }, refreshing: false });
        return;
      }
      const info = await window.electronAPI.git.info(root);
      set({ status: info, refreshing: false });
    } catch {
      set({ status: null, refreshing: false });
    }
  },

  pushRepo: async (message) => {
    const root = await openRoot();
    if (!root) {
      const res = { ok: false, message: 'Error: no project folder is open — open a folder first.' };
      set({ result: res });
      return res;
    }
    const repo = normalizeRepo(get().repo);
    const token = loadToken();
    set({ pushing: true, result: null });
    let res: RepoPushResult;
    try {
      const out = await window.electronAPI.git.pushProject({
        cwd: root,
        message,
        repo: repo || undefined,
        token: token || undefined,
      });
      res = out.ok ? { ok: true, message: out.message } : { ok: false, message: `Error: ${out.message}` };
    } catch (e: any) {
      res = { ok: false, message: `Error: ${e?.message || String(e)}` };
    }
    set({ pushing: false, result: res, lastPushAt: res.ok ? Date.now() : get().lastPushAt });
    if (res.ok) void get().refresh();
    return res;
  },
}));
