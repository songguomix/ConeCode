import { create } from 'zustand';
import type { GithubAccountStatus, GithubPushBranches } from '../types/github.types';

// The GitHub plugin's state. Its whole job is to push the *open project* to a
// GitHub repo: it stores where to push and the token to push with, reads the
// project's git state, and runs one commit+push. No skills, no SKILL.md — the
// chat model only ever asks this store to push; it never touches git itself.
const REPO_KEY = 'conecode.pluginRepo';
const REPOS_KEY = 'conecode.pluginRepos';
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

export interface RepoPushTarget extends GithubPushBranches {
  root: string;
  repo: string;
}

interface MarketStore {
  /** "owner/repo" the open project is pushed to. */
  repo: string;
  repos: string[];
  tokenSet: boolean;
  account: GithubAccountStatus | null;
  /** Git state of the open project; null until refreshed with a folder open. */
  status: RepoStatus | null;
  refreshing: boolean;
  pushing: boolean;
  /** When the last successful push happened (for the view). */
  lastPushAt: number | null;
  /** Last push outcome — kept so the view can show exactly what the model saw. */
  result: RepoPushResult | null;
  setRepo: (repo: string) => void;
  addRepo: (repo: string) => boolean;
  removeRepo: (repo: string) => void;
  setAccount: (status: GithubAccountStatus) => void;
  refreshAccount: () => Promise<void>;
  /** Persist a token (or null to forget it). The value never enters state. */
  setToken: (token: string | null) => void;
  /** Read the open project's git state (branch, uncommitted count). */
  refresh: () => Promise<void>;
  /**
   * Push a local branch to the selected destination. The main process handles
   * credentials and only includes working-tree edits for the checked-out branch.
   */
  pushRepo: (message?: string, target?: RepoPushTarget) => Promise<RepoPushResult>;
}

function loadRepo(): string {
  try {
    return localStorage.getItem(REPO_KEY) || '';
  } catch {
    return '';
  }
}

function addPreset(repos: string[], repo: string): string[] {
  return repos.some((item) => item.toLowerCase() === repo.toLowerCase()) ? repos : [...repos, repo];
}

function loadPresets(): string[] {
  let repos: string[] = [];
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(REPOS_KEY) || '[]');
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const repo = typeof entry === 'string' ? normalizeRepo(entry) : null;
        if (repo) repos = addPreset(repos, repo);
      }
    }
  } catch {}
  const selected = normalizeRepo(loadRepo());
  return selected ? addPreset(repos, selected) : repos;
}

function saveRepos(repo: string, repos: string[]): void {
  try {
    localStorage.setItem(REPO_KEY, repo);
    localStorage.setItem(REPOS_KEY, JSON.stringify(repos));
  } catch {}
}

export function loadGithubToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

/** Accept "owner/repo" or a github.com URL, reject everything else. */
export function normalizeRepo(input: string): string | null {
  const t = input.trim().replace(/\/+$/, '');
  const match = t.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  if (!match || ['.', '..'].includes(match[2])) return null;
  return `${match[1]}/${match[2]}`;
}

async function openRoot(): Promise<string | null> {
  const { useWorkspaceStore } = await import('./workspace.store');
  return useWorkspaceStore.getState().rootPath || null;
}

let accountRequest = 0;
let accountCheck: { request: number; pending: Promise<void> } | undefined;
let statusRequest = 0;

export const useMarketStore = create<MarketStore>((set, get) => ({
  repo: normalizeRepo(loadRepo()) ?? loadRepo(),
  repos: loadPresets(),
  tokenSet: !!loadGithubToken(),
  account: null,
  status: null,
  refreshing: false,
  pushing: false,
  lastPushAt: null,
  result: null,

  setRepo: (repo) => {
    const normalized = normalizeRepo(repo);
    const repos = normalized ? addPreset(get().repos, normalized) : get().repos;
    const selected = repos.find((item) => item.toLowerCase() === normalized?.toLowerCase()) ?? repo.trim();
    saveRepos(selected, repos);
    set({ repo: selected, repos });
  },

  addRepo: (repo) => {
    const normalized = normalizeRepo(repo);
    if (!normalized) return false;
    get().setRepo(normalized);
    return true;
  },

  removeRepo: (repo) => {
    const key = repo.toLowerCase();
    const repos = get().repos.filter((item) => item.toLowerCase() !== key);
    const selected = get().repo.toLowerCase() === key ? '' : get().repo;
    saveRepos(selected, repos);
    set({ repo: selected, repos });
  },

  setAccount: (account) => {
    accountRequest++;
    set({ account });
  },

  refreshAccount: async () => {
    const bridge = globalThis.window?.electronAPI?.githubAccount;
    if (!bridge) return;
    if (accountCheck?.request === accountRequest) return accountCheck.pending;
    const request = accountRequest;
    const pending = bridge.status()
      .catch((): GithubAccountStatus => ({ state: 'error', error: 'status-failed' }))
      .then((account) => { if (request === accountRequest) set({ account }); })
      .finally(() => { if (accountCheck?.request === request) accountCheck = undefined; });
    accountCheck = { request, pending };
    return pending;
  },

  setToken: (token) => {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {}
    set({ tokenSet: !!token });
  },

  refresh: async () => {
    const request = ++statusRequest;
    const root = await openRoot();
    if (request !== statusRequest) return;
    set({ refreshing: true });
    try {
      if (!root) {
        set({ status: { isRepo: false, branch: null, dirty: 0 }, refreshing: false });
        return;
      }
      const info = await window.electronAPI.git.info(root);
      if (request === statusRequest) set({ status: info, refreshing: false });
    } catch {
      if (request === statusRequest) set({ status: null, refreshing: false });
    }
  },

  pushRepo: async (message, target) => {
    const root = target?.root ?? await openRoot();
    if (!root) {
      const res = { ok: false, message: 'Error: no project folder is open — open a folder first.' };
      set({ result: res });
      return res;
    }
    // A typed-but-invalid id must fail LOUDLY, not silently degrade: normalize
    // rejects e.g. "songguomix/" after which `repo || undefined` would push to
    // whatever "origin" happens to be (token unused) with no word of warning.
    const raw = (target?.repo ?? get().repo).trim();
    if (raw && !normalizeRepo(raw)) {
      const res = {
        ok: false,
        message: `Error: "${raw}" is not a valid owner/repo — use owner/repo or a github.com URL.`,
      };
      set({ result: res });
      return res;
    }
    const repo = normalizeRepo(raw);
    if (get().pushing) return { ok: false, message: 'Error: another GitHub push is in progress.' };
    const token = loadGithubToken();
    set({ pushing: true, result: null });
    let res: RepoPushResult;
    try {
      const out = await window.electronAPI.git.pushProject({
        cwd: root,
        message,
        repo: repo || undefined,
        token: token || undefined,
        ...(target?.sourceBranch && { sourceBranch: target.sourceBranch }),
        ...(target?.targetBranch && { targetBranch: target.targetBranch }),
        ...(target?.createTarget && { createTarget: true }),
        ...(target?.commitChanges !== undefined && { commitChanges: target.commitChanges }),
        ...(target?.originKey && { originKey: target.originKey }),
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

export async function hasGithubCredentials(): Promise<boolean> {
  if (loadGithubToken()) return true;
  const store = useMarketStore.getState();
  if (store.account?.state === 'signed-in') return true;
  await store.refreshAccount();
  return useMarketStore.getState().account?.state === 'signed-in';
}
