import { create } from 'zustand';
import { normalizeRepo, useMarketStore, type RepoPushResult } from './market.store';
import { useWorkspaceStore } from './workspace.store';

interface PushRequest {
  root: string;
  repo: string;
  message?: string;
}
interface PushState {
  pending: PushRequest | null;
  request: (message?: string) => Promise<RepoPushResult>;
  confirm: (repo: string) => void;
  cancel: () => void;
}
let settle: ((result: RepoPushResult) => void) | null = null;

export const useGithubPushStore = create<PushState>((set, get) => ({
  pending: null,
  request: async (message) => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return { ok: false, message: 'Error: no project folder is open.' };
    if (get().pending || settle) return { ok: false, message: 'Error: another GitHub push is awaiting confirmation.' };
    return new Promise((resolve) => {
      settle = resolve;
      set({ pending: { root, repo: useMarketStore.getState().repo, message } });
    });
  },
  confirm: (input) => {
    const request = get().pending;
    const repo = normalizeRepo(input);
    if (!request || !repo || !settle) return;
    const resolve = settle;
    settle = null;
    set({ pending: null });
    // Freeze both destination and source; changing chats/settings cannot redirect
    // an approved push to a different repository or workspace.
    void useMarketStore.getState().pushRepo(request.message, { root: request.root, repo })
      .then(resolve, (error) => resolve({ ok: false, message: `Error: ${String(error)}` }));
  },
  cancel: () => {
    const resolve = settle;
    settle = null;
    set({ pending: null });
    resolve?.({ ok: false, message: 'GitHub push cancelled by the user. Do not retry without a new request.' });
  },
}));
