import { create } from 'zustand';
import { buildReplyDraft } from '../core/githubReply/replyText';
import { hasGithubCredentials } from './market.store';
import type {
  ReplyContextResult,
  ReplyLanguage,
  ReplyListResult,
  ReplyPostResult,
  ReplyThreadContext,
  ReplyThreadSummary,
} from '../types/githubReply.types';

/**
 * State for the GitHub plugin's "reply assistant" tab.
 *
 * Requests go through the main process (window.electronAPI.githubReply) so the
 * renderer never deals with CORS or Node APIs. A draft is always generated
 * locally and only posted after the user confirms — nothing is automatic.
 */

interface ReplyBridge {
  list: (options: { repo: string; token: string }) => Promise<ReplyListResult>;
  context: (options: { repo: string; token: string; number: number }) => Promise<ReplyContextResult>;
  post: (options: { repo: string; token: string; number: number; body: string }) => Promise<ReplyPostResult>;
}

export interface ReplyPostState {
  ok: boolean;
  message: string;
  url?: string;
}

export interface GithubReplyState {
  language: ReplyLanguage;
  threads: ReplyThreadSummary[];
  loadingList: boolean;
  listError: string | null;
  selectedNumber: number | null;
  context: ReplyThreadContext | null;
  loadingContext: boolean;
  contextError: string | null;
  draft: string;
  posting: boolean;
  postResult: ReplyPostState | null;
  setLanguage: (language: ReplyLanguage) => void;
  loadThreads: (repo: string, token: string) => Promise<void>;
  selectThread: (number: number, repo: string, token: string) => Promise<void>;
  setDraft: (draft: string) => void;
  regenerateDraft: () => void;
  post: (repo: string, token: string) => Promise<boolean>;
  reset: () => void;
}

const LANG_KEY = 'githubReply.language';

function bridge(): ReplyBridge {
  const api = (globalThis as { window?: { electronAPI?: { githubReply?: ReplyBridge } } }).window
    ?.electronAPI?.githubReply;
  if (!api) throw new Error('GitHub reply bridge is unavailable.');
  return api;
}

export function loadReplyLanguage(): ReplyLanguage {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'auto' || stored === 'zh' || stored === 'en') return stored;
  } catch {
    // localStorage can be unavailable; fall back to auto.
  }
  return 'auto';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let listRequest = 0;
let threadRequest = 0;
let postRequest = 0;

export const useGithubReplyStore = create<GithubReplyState>((set, get) => ({
  language: loadReplyLanguage(),
  threads: [],
  loadingList: false,
  listError: null,
  selectedNumber: null,
  context: null,
  loadingContext: false,
  contextError: null,
  draft: '',
  posting: false,
  postResult: null,

  setLanguage: (language) => {
    try {
      localStorage.setItem(LANG_KEY, language);
    } catch {
      // Non-fatal: the choice still applies for this session.
    }
    set({ language });
    const { context } = get();
    if (context) set({ draft: buildReplyDraft(context, { language }) });
  },

  loadThreads: async (repo, token) => {
    const request = ++listRequest;
    const trimmed = repo.trim();
    if (!trimmed) {
      set({
        threads: [],
        listError: 'Set the repository as owner/repo in the GitHub plugin first.',
        loadingList: false,
      });
      return;
    }
    set({ loadingList: true, listError: null });
    try {
      const result = await bridge().list({ repo: trimmed, token });
      if (request !== listRequest) return;
      if (!result.ok) {
        set({ loadingList: false, threads: [], listError: result.message ?? 'Could not load issues and pull requests.' });
        return;
      }
      set({ loadingList: false, threads: result.items, listError: null });
    } catch (error) {
      if (request === listRequest) set({ loadingList: false, threads: [], listError: errorMessage(error) });
    }
  },

  selectThread: async (number, repo, token) => {
    const request = ++threadRequest;
    set({
      selectedNumber: number,
      loadingContext: true,
      contextError: null,
      context: null,
      draft: '',
      postResult: null,
    });
    try {
      const result = await bridge().context({ repo: repo.trim(), token, number });
      if (request !== threadRequest) return;
      if (!result.ok || !result.context) {
        set({
          loadingContext: false,
          contextError: result.message ?? 'Could not load this thread.',
        });
        return;
      }
      set({
        loadingContext: false,
        context: result.context,
        draft: buildReplyDraft(result.context, { language: get().language }),
      });
    } catch (error) {
      if (request === threadRequest) set({ loadingContext: false, contextError: errorMessage(error) });
    }
  },

  setDraft: (draft) => set({ draft }),

  regenerateDraft: () => {
    const { context, language } = get();
    if (context) set({ draft: buildReplyDraft(context, { language }) });
  },

  post: async (repo, token) => {
    const { selectedNumber, draft, posting, context } = get();
    if (posting || selectedNumber === null) return false;
    const target = repo.trim();
    if (context && context.repo.toLowerCase() !== target.toLowerCase()) return false;
    if (!draft.trim()) {
      set({ postResult: { ok: false, message: 'Write a reply before posting.' } });
      return false;
    }
    const request = ++postRequest;
    set({ posting: true, postResult: null });
    try {
      const authenticated = token || await hasGithubCredentials();
      if (request !== postRequest) return false;
      if (!authenticated) {
        set({ posting: false, postResult: { ok: false, message: 'Sign in to GitHub or save a GitHub token with Issues write access.' } });
        return false;
      }
      const result = await bridge().post({ repo: target, token, number: selectedNumber, body: draft });
      if (request !== postRequest) return false;
      set({
        posting: false,
        postResult: { ok: result.ok, message: result.message, url: result.url },
      });
      if (result.ok) {
        const { threads, context } = get();
        set({
          threads: threads.map((thread) =>
            thread.number === selectedNumber ? { ...thread, comments: thread.comments + 1 } : thread
          ),
          context: context?.number === selectedNumber ? { ...context, comments: context.comments + 1 } : context,
        });
      }
      return result.ok;
    } catch (error) {
      if (request === postRequest) set({ posting: false, postResult: { ok: false, message: errorMessage(error) } });
      return false;
    }
  },

  reset: () => {
    listRequest++;
    threadRequest++;
    postRequest++;
    set({
      threads: [],
      loadingList: false,
      listError: null,
      selectedNumber: null,
      context: null,
      loadingContext: false,
      contextError: null,
      draft: '',
      posting: false,
      postResult: null,
    });
  },
}));
