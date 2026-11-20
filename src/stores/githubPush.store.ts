import { create } from 'zustand';
import { normalizeRepo, useMarketStore, type RepoPushResult, type RepoPushTarget } from './market.store';
import { useWorkspaceStore } from './workspace.store';
import type { GithubPushBranches } from '../types/github.types';

interface PushRequest extends RepoPushTarget {
  message?: string;
}
interface PushState {
  pending: PushRequest | null;
  request: (message?: string, target?: RepoPushTarget) => Promise<RepoPushResult>;
  confirm: (repo: string, branches?: GithubPushBranches) => void;
  cancel: () => void;
}
let settle: ((result: RepoPushResult) => void) | null = null;

export const useGithubPushStore = create<PushState>((set, get) => ({
  pending: null,
  request: async (message, target) => {
    const root = target?.root ?? useWorkspaceStore.getState().rootPath;
    if (!root) return { ok: false, message: 'Error: no project folder is open.' };
    if (get().pending || settle) return { ok: false, message: 'Error: another GitHub push is awaiting confirmation.' };
    const market = useMarketStore.getState();
    if (market.pushing) return { ok: false, message: 'Error: another GitHub push is in progress.' };
    return new Promise((resolve) => {
      settle = resolve;
      set({ pending: { ...target, root, repo: target?.repo ?? market.repo, message } });
    });
  },
  confirm: (input, branches) => {
    const request = get().pending;
    if (!request || !settle) return;
    const repo = input.trim() ? normalizeRepo(input) : '';
    if (repo === null) return;
    const { sourceBranch, targetBranch, createTarget, commitChanges, originKey } = branches ?? request;
    const resolve = settle;
    settle = null;
    set({ pending: null });
    // Freeze both destination and source; changing chats/settings cannot redirect
    // an approved push to a different repository or workspace.
    void useMarketStore.getState().pushRepo(request.message, {
      root: request.root,
      repo,
      ...(sourceBranch && { sourceBranch }),
      ...(targetBranch && { targetBranch }),
      ...(createTarget && { createTarget }),
      ...(commitChanges !== undefined && { commitChanges }),
      ...(!repo && originKey && { originKey }),
    })
      .then(resolve, (error) => resolve({ ok: false, message: `Error: ${String(error)}` }));
  },
  cancel: () => {
    const resolve = settle;
    settle = null;
    set({ pending: null });
    resolve?.({ ok: false, message: 'GitHub push cancelled by the user. Do not retry without a new request.' });
  },
}));
