import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeRepo, useMarketStore } from './market.store';
import { useWorkspaceStore } from './workspace.store';

const pushProject = vi.fn(async () => ({ ok: true, message: 'Pushed branch "main" to o/r.' }));
const gitInfo = vi.fn(async () => ({ isRepo: true, branch: 'main', dirty: 2 }));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  pushProject.mockResolvedValue({ ok: true, message: 'Pushed branch "main" to o/r.' });
  gitInfo.mockResolvedValue({ isRepo: true, branch: 'main', dirty: 2 });
  useMarketStore.setState({
    repo: '',
    tokenSet: false,
    status: null,
    refreshing: false,
    pushing: false,
    lastPushAt: null,
    result: null,
  });
  useWorkspaceStore.setState({ rootPath: null });
  (globalThis as any).window = {
    electronAPI: {
      git: { info: gitInfo, pushProject },
    },
  };
});

describe('normalizeRepo', () => {
  it('accepts owner/repo and github URLs, rejects the rest', () => {
    expect(normalizeRepo('o/r')).toBe('o/r');
    expect(normalizeRepo('https://github.com/o/r')).toBe('o/r');
    expect(normalizeRepo('https://github.com/o/r.git')).toBe('o/r');
    expect(normalizeRepo('not a repo')).toBeNull();
    expect(normalizeRepo('')).toBeNull();
  });
});

describe('repo status', () => {
  it('reports "not a repo" when no folder is open', async () => {
    await useMarketStore.getState().refresh();
    expect(gitInfo).not.toHaveBeenCalled();
    expect(useMarketStore.getState().status?.isRepo).toBe(false);
  });

  it('reads branch and uncommitted count from the open project', async () => {
    useWorkspaceStore.setState({ rootPath: '/proj' });
    await useMarketStore.getState().refresh();
    expect(gitInfo).toHaveBeenCalledWith('/proj');
    expect(useMarketStore.getState().status).toEqual({ isRepo: true, branch: 'main', dirty: 2 });
  });
});

describe('pushRepo', () => {
  it('refuses without an open project', async () => {
    const res = await useMarketStore.getState().pushRepo();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('no project folder');
    expect(pushProject).not.toHaveBeenCalled();
  });

  it('pushes the open project through the configured repo and token', async () => {
    useWorkspaceStore.setState({ rootPath: '/proj' });
    localStorage.setItem('conecode.pluginToken', 'tok');
    useMarketStore.setState({ repo: 'https://github.com/o/r.git' });

    const res = await useMarketStore.getState().pushRepo('Fix the login redirect');

    expect(res.ok).toBe(true);
    expect(pushProject).toHaveBeenCalledWith({
      cwd: '/proj',
      message: 'Fix the login redirect',
      repo: 'o/r',
      token: 'tok',
    });
    expect(useMarketStore.getState().result?.ok).toBe(true);
    expect(useMarketStore.getState().lastPushAt).not.toBeNull();
    // A successful push refreshes the project's git status (fire-and-forget).
    await vi.waitFor(() => expect(gitInfo).toHaveBeenCalledWith('/proj'));
    localStorage.removeItem('conecode.pluginToken');
  });

  it('surfaces a failed push without advancing the last-push time', async () => {
    useWorkspaceStore.setState({ rootPath: '/proj' });
    gitInfo.mockResolvedValue({ isRepo: true, branch: 'main', dirty: 0 });
    pushProject.mockResolvedValue({ ok: false, message: 'git push failed.' });

    const res = await useMarketStore.getState().pushRepo();

    expect(res.ok).toBe(false);
    expect(res.message).toBe('Error: git push failed.');
    expect(useMarketStore.getState().lastPushAt).toBeNull();
    expect(useMarketStore.getState().result).toEqual({ ok: false, message: 'Error: git push failed.' });
  });
});
