import { create } from 'zustand';
import { loadGithubToken, useMarketStore } from './market.store';
import { useLanguageStore } from './language.store';

export interface GithubReleaseRequest {
  /** Normalized owner/repo. */
  repo: string;
  tag: string;
  name: string;
  notes: string;
  target: string;
  /** Absolute attachment paths (the built installers). */
  files: string[];
  draft: boolean;
  prerelease: boolean;
}

export interface ReleaseOutcome {
  ok: boolean;
  message: string;
  url?: string;
}

/** What the caller supplies; the store fills the defaults on admission. */
export interface GithubReleaseInput {
  repo: string;
  tag: string;
  name?: string;
  notes?: string;
  target?: string;
  files: string[];
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * AI-initiated GitHub release publishing, gated behind an explicit user
 * confirmation — the same contract as the GitHub push: the model fills in the
 * details and asks, the user reviews the card and clicks confirm. Nothing is
 * uploaded without that click.
 */
interface ReleaseState {
  pending: GithubReleaseRequest | null;
  busy: boolean;
  request: (partial: GithubReleaseInput) => Promise<ReleaseOutcome>;
  confirm: () => void;
  cancel: () => void;
}

let settle: ((result: ReleaseOutcome) => void) | null = null;

export const useGithubReleaseStore = create<ReleaseState>((set, get) => ({
  pending: null,
  busy: false,
  request: async (partial) => {
    if (get().pending || settle) {
      return { ok: false, message: 'Error: another GitHub release is awaiting confirmation. Finish or cancel it first.' };
    }
    return new Promise((resolve) => {
      settle = resolve;
      set({
        pending: {
          repo: partial.repo,
          tag: partial.tag,
          name: partial.name?.trim() || partial.tag,
          notes: partial.notes || '',
          target: partial.target || 'main',
          files: partial.files,
          draft: !!partial.draft,
          prerelease: !!partial.prerelease,
        },
      });
    });
  },
  confirm: () => {
    const request = get().pending;
    if (!request || !settle) return;
    const resolve = settle;
    settle = null;
    set({ pending: null, busy: true });
    const token = loadGithubToken();
    if (!token) {
      set({ busy: false });
      resolve({ ok: false, message: useLanguageStore.getState().t('releaseTokenRequired') });
      return;
    }
    const configuredRepo = useMarketStore.getState().repo;
    void window.electronAPI.git
      .publishRelease({ ...request, token, repo: request.repo || configuredRepo })
      .then((result) => {
        set({ busy: false });
        resolve(result);
      })
      .catch(() => {
        set({ busy: false });
        resolve({ ok: false, message: useLanguageStore.getState().t('releaseFailed') });
      });
  },
  cancel: () => {
    const resolve = settle;
    settle = null;
    set({ pending: null, busy: false });
    resolve?.({ ok: false, message: 'GitHub release cancelled by the user. Do not retry without a new request.' });
  },
}));
