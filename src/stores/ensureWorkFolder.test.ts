import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from './chat.store';
import { useWorkspaceStore } from './workspace.store';
import { useUIStore } from './ui.store';

vi.mock('./autopilot.store', () => ({
  createProjectDir: vi.fn(),
}));
import { createProjectDir } from './autopilot.store';

const mockedCreateProjectDir = vi.mocked(createProjectDir);

/** IPC mocks covering folder selection and conversation persistence. */
function mockElectron() {
  const electron = {
    conversation: {
      create: vi.fn().mockImplementation((data: any) => {
        created.push(data);
        return Promise.resolve({ id: `conv-${created.length}`, title: '', ...data, createdAt: 0, updatedAt: 0 });
      }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    message: { create: vi.fn().mockResolvedValue(undefined) },
    dialog: {
      openFolder: vi.fn().mockResolvedValue('/picked'),
    },
    fs: {
      stat: vi.fn().mockResolvedValue({ isDirectory: true }),
      readDir: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue(null),
    },
    mcp: { reload: vi.fn().mockResolvedValue([]) },
    app: { getSystemInfo: vi.fn().mockResolvedValue({ homedir: '/home/u' }) },
  };
  const created: any[] = [];
  (globalThis as any).window = { electronAPI: electron };
  return { electron, created };
}

function seedConversation(overrides: Record<string, unknown> = {}) {
  useChatStore.setState({
    conversations: [{
      id: 'conv-1',
      title: 'Build a todo app',
      providerId: 'p1',
      modelId: 'm1',
      rootPath: null,
      isChatMode: true,
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    } as any],
    activeConversationId: 'conv-1',
    messages: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ conversations: [], activeConversationId: null, messages: [] });
  useWorkspaceStore.setState({ rootPath: null, extraRoots: [] });
  useUIStore.setState({ viewMode: 'work' });
});

describe('ensureWorkFolder', () => {
  it('binds the already-open folder instead of creating one', async () => {
    seedConversation();
    useWorkspaceStore.setState({ rootPath: '/existing', extraRoots: [] });
    const { electron } = mockElectron();

    const bound = await useChatStore.getState().ensureWorkFolder();

    expect(bound).toBe('/existing');
    expect(mockedCreateProjectDir).not.toHaveBeenCalled();
    expect(electron.conversation.update).toHaveBeenCalledWith('conv-1', expect.objectContaining({ rootPath: '/existing', isChatMode: false }));
    expect(useChatStore.getState().conversations[0].rootPath).toBe('/existing');
  });

  it('asks for an existing folder instead of auto-creating one', async () => {
    seedConversation();
    const { electron, created } = mockElectron();

    const bound = await useChatStore.getState().ensureWorkFolder();

    expect(mockedCreateProjectDir).not.toHaveBeenCalled();
    expect(electron.dialog.openFolder).toHaveBeenCalledOnce();
    expect(bound).toBe('/picked');
    expect(useWorkspaceStore.getState().rootPath).toBe('/picked');
    expect(created).toHaveLength(0);
    expect(useChatStore.getState().activeConversationId).toBe('conv-1');
    expect(useChatStore.getState().conversations[0]).toMatchObject({ rootPath: '/picked', isChatMode: false });
  });

  it('creates a bound conversation only after a folder is chosen when none is active', async () => {
    useChatStore.setState({ conversations: [], activeConversationId: null, messages: [] });
    const { electron, created } = mockElectron();

    const bound = await useChatStore.getState().ensureWorkFolder();

    expect(mockedCreateProjectDir).not.toHaveBeenCalled();
    expect(electron.dialog.openFolder).toHaveBeenCalledOnce();
    expect(bound).toBe('/picked');
    expect(created[0]).toMatchObject({ rootPath: '/picked' });
    expect(useChatStore.getState().activeConversationId).toBe('conv-1');
  });

  it('keeps the chat and workspace unchanged when folder selection is cancelled', async () => {
    seedConversation();
    const { electron, created } = mockElectron();
    electron.dialog.openFolder.mockResolvedValue(null);

    const bound = await useChatStore.getState().ensureWorkFolder();

    expect(bound).toBeNull();
    expect(mockedCreateProjectDir).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(electron.conversation.update).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().rootPath).toBeNull();
    expect(useChatStore.getState().activeConversationId).toBe('conv-1');
    expect(useChatStore.getState().conversations[0]).toMatchObject({ rootPath: null, isChatMode: true });
  });
});
