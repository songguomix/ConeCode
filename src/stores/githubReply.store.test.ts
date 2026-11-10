import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGithubReplyStore } from './githubReply.store';
import type { ReplyThreadContext } from '../types/githubReply.types';

const context: ReplyThreadContext = {
  repo: 'acme/widgets',
  number: 7,
  title: 'Crash when starting the app',
  body: 'Steps to reproduce: run it. Expected: starts. Actual: crash.',
  author: 'alice',
  labels: ['bug'],
  comments: 1,
  updatedAt: '2025-01-01T00:00:00Z',
  url: 'https://github.com/acme/widgets/issues/7',
  isPullRequest: false,
  state: 'open',
  recentComments: [],
};

function installBridge(overrides: Partial<{ list: any; context: any; post: any }> = {}) {
  const bridge = {
    list: vi.fn(async () => ({ ok: true, items: [{ ...context, isPullRequest: false }] })),
    context: vi.fn(async () => ({ ok: true, context })),
    post: vi.fn(async () => ({ ok: true, id: 99, url: 'https://github.com/acme/widgets/issues/7#issuecomment-99', message: 'Reply posted to #7.' })),
    ...overrides,
  };
  (globalThis as any).window = { electronAPI: { githubReply: bridge } };
  return bridge;
}

beforeEach(() => {
  (globalThis as any).window = undefined;
  useGithubReplyStore.setState({
    language: 'auto',
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
});

describe('GitHub reply store', () => {
  it('asks for a repository instead of calling the bridge without one', async () => {
    const bridge = installBridge();
    await useGithubReplyStore.getState().loadThreads('   ', '');
    expect(bridge.list).not.toHaveBeenCalled();
    expect(useGithubReplyStore.getState().listError).toContain('owner/repo');
  });

  it('loads threads and surfaces API errors', async () => {
    const bridge = installBridge();
    await useGithubReplyStore.getState().loadThreads('acme/widgets', 'token');
    expect(bridge.list).toHaveBeenCalledWith({ repo: 'acme/widgets', token: 'token' });
    expect(useGithubReplyStore.getState().threads).toHaveLength(1);

    const failing = installBridge({ list: vi.fn(async () => ({ ok: false, items: [], message: 'GitHub denied (403).' })) });
    await useGithubReplyStore.getState().loadThreads('acme/widgets', '');
    expect(failing.list).toHaveBeenCalled();
    expect(useGithubReplyStore.getState().listError).toContain('403');
    expect(useGithubReplyStore.getState().threads).toEqual([]);
  });

  it('selects a thread and generates an editable draft', async () => {
    installBridge();
    await useGithubReplyStore.getState().selectThread(7, 'acme/widgets', 'token');
    const state = useGithubReplyStore.getState();
    expect(state.context?.number).toBe(7);
    expect(state.draft).toContain('alice');
    expect(state.draft).toContain('acme/widgets');
  });

  it('regenerates the draft in the selected language', () => {
    useGithubReplyStore.setState({ context });
    useGithubReplyStore.getState().setLanguage('zh');
    expect(useGithubReplyStore.getState().draft).toContain('感谢');
    useGithubReplyStore.getState().setLanguage('en');
    expect(useGithubReplyStore.getState().draft).toContain('Thanks');
  });

  it('refuses to post without a token or draft', async () => {
    const bridge = installBridge();
    useGithubReplyStore.setState({ selectedNumber: 7, draft: 'hello' });
    await useGithubReplyStore.getState().post('acme/widgets', '');
    expect(bridge.post).not.toHaveBeenCalled();
    expect(useGithubReplyStore.getState().postResult?.message).toContain('token');

    useGithubReplyStore.setState({ postResult: null, draft: '   ' });
    await useGithubReplyStore.getState().post('acme/widgets', 'token');
    expect(bridge.post).not.toHaveBeenCalled();
    expect(useGithubReplyStore.getState().postResult?.message).toContain('Write a reply');
  });

  it('posts a confirmed reply and updates the comment count', async () => {
    const bridge = installBridge();
    useGithubReplyStore.setState({
      selectedNumber: 7,
      context,
      draft: 'Thanks for the report!',
      threads: [{ ...context }],
    });
    const ok = await useGithubReplyStore.getState().post('acme/widgets', 'token');
    expect(ok).toBe(true);
    expect(bridge.post).toHaveBeenCalledWith({
      repo: 'acme/widgets',
      token: 'token',
      number: 7,
      body: 'Thanks for the report!',
    });
    const state = useGithubReplyStore.getState();
    expect(state.postResult?.url).toContain('issuecomment-99');
    expect(state.threads[0].comments).toBe(2);
  });

  it('surfaces bridge failures without throwing', async () => {
    installBridge({ post: vi.fn(async () => { throw new Error('bridge offline'); }) });
    useGithubReplyStore.setState({ selectedNumber: 7, draft: 'hello' });
    const ok = await useGithubReplyStore.getState().post('acme/widgets', 'token');
    expect(ok).toBe(false);
    expect(useGithubReplyStore.getState().postResult?.message).toContain('bridge offline');
  });
});
