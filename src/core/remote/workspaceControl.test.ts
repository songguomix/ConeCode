import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const workspace = {
    rootPath: '/repo', allRoots: () => ['/repo'], dirtyTabs: {}, selectedFile: null,
    createFile: vi.fn(), deletePath: vi.fn(), renamePath: vi.fn(), selectFile: vi.fn(),
  };
  return { workspace, chat: { activeConversationId: 'chat-1', isStreaming: false } };
});

vi.mock('../../stores/workspace.store', () => ({
  useWorkspaceStore: { getState: () => state.workspace },
  isValidFileName: (name: string) => !!name,
  isImageFile: () => false,
}));
vi.mock('../../stores/chat.store', () => ({ useChatStore: { getState: () => state.chat } }));
vi.mock('../../stores/model.store', () => ({ useModelStore: { getState: vi.fn() } }));

import { handleWorkspaceControl } from './workspaceControl';

const fs = {
  realpath: vi.fn((path: string): Promise<string | null> => Promise.resolve(path)),
  stat: vi.fn(async () => ({ isDirectory: true, isFile: true, size: 10 })),
  exists: vi.fn(async () => false),
  readFile: vi.fn(async () => 'saved on desktop'),
  writeFile: vi.fn(async () => true),
};
const git = { review: vi.fn(async () => ({ ok: true, status: '', diff: 'x'.repeat(90_000) })) };
const worktree = {
  list: vi.fn(async () => ({ currentPath: '/managed/tree', worktrees: [
    { path: '/managed/tree', isMain: false, managed: true },
    { path: '/repo', isMain: true, managed: false },
  ] })),
  remove: vi.fn(async () => ({ ok: true })),
};

async function request(action: string, fields: Record<string, unknown>) {
  const reply = vi.fn();
  await handleWorkspaceControl({ action, ...fields }, reply);
  expect(reply).toHaveBeenCalledTimes(1);
  return reply.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { electronAPI: { fs, git, worktree } });
  state.workspace.rootPath = '/repo';
});
afterEach(() => vi.unstubAllGlobals());

describe('workspace remote commands', () => {
  it('refuses paths outside the open workspace, including links and traversal', async () => {
    fs.realpath.mockImplementationOnce(async () => '/other');
    await expect(request('workspaceFileAction', { operation: 'delete', path: '/repo/link' })).resolves.toMatchObject({ ok: false });
    await expect(request('workspaceFileAction', { operation: 'delete', path: '/repo/../other' })).resolves.toMatchObject({ ok: false });
    await expect(request('workspaceFileAction', { operation: 'delete', path: '/repo' })).resolves.toMatchObject({ ok: false });
    expect(state.workspace.deletePath).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing file on create, or newer content on save', async () => {
    fs.exists.mockResolvedValueOnce(true);
    await expect(request('workspaceFileAction', { operation: 'createFile', path: '/repo', name: 'notes.md' }))
      .resolves.toMatchObject({ ok: false, error: 'already-exists' });
    await expect(request('workspaceWriteFile', { path: '/repo/notes.md', previous: 'older', content: 'phone edit' }))
      .resolves.toMatchObject({ ok: false, error: 'unsaved-editor' });
    expect(state.workspace.createFile).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();

    await expect(request('workspaceWriteFile', { path: '/repo/notes.md', previous: 'saved on desktop', content: 'phone edit' }))
      .resolves.toEqual({ ok: true });
    expect(fs.writeFile).toHaveBeenCalledWith('/repo/notes.md', 'phone edit', { expected: 'saved on desktop' });
  });

  it('rejects stale repositories and bounds the Git diff sent to the phone', async () => {
    await expect(request('workspaceGitDiff', { root: '/old', scope: 'uncommitted' })).resolves.toMatchObject({ ok: false, error: 'stale-workspace' });
    expect(git.review).not.toHaveBeenCalled();
    const result = await request('workspaceGitDiff', { root: '/repo', scope: 'uncommitted' });
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.diff).toHaveLength(80_000);
  });

  it('refuses removal of the checked-out worktree', async () => {
    await expect(request('workspaceRemoveWorktree', { root: '/repo', path: '/managed/tree' })).resolves.toMatchObject({ ok: false });
    expect(worktree.remove).not.toHaveBeenCalled();
  });
});
