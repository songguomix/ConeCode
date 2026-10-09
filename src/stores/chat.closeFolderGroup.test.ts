import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from './chat.store';
import { useWorkspaceStore } from './workspace.store';

function installStubs() {
  (globalThis as any).window = {
    electronAPI: {
      conversation: { update: vi.fn(async () => ({})) },
      message: { list: async () => [] },
      app: { getSystemInfo: async () => ({ homedir: '/home/test' }) },
      fs: {
        readDir: async () => [],
        readFile: async () => null,
        readFileBase64: async () => null,
        stat: async () => ({ isDirectory: true }),
      },
    },
  };
}

const conv = (id: string, rootPath: string | null = null) => ({
  id, title: id, providerId: 'p1', modelId: 'm1', createdAt: 0, updatedAt: 0, rootPath,
});

beforeEach(() => {
  installStubs();
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    workspaceSnapshots: new Map(),
  });
  useWorkspaceStore.setState({
    rootPath: null,
    files: [],
    extraRoots: [],
    selectedFile: null,
    fileContent: null,
    selectedFileIsImage: false,
    openTabs: [],
    dirtyTabs: {},
    contextFiles: [],
    fileList: null,
  });
});

describe('closeFolderGroup (sidebar badge click)', () => {
  it('detaches the folder and lands on home, but keeps chats bound', async () => {
    useChatStore.setState({
      conversations: [conv('c1', '/proj'), conv('c2', '/proj')],
      activeConversationId: 'c1',
      messages: [{ id: 'm', conversationId: 'c1', role: 'user', content: 'hi', createdAt: 0 } as any],
    });
    useWorkspaceStore.setState({ rootPath: '/proj' });

    await useChatStore.getState().closeFolderGroup('/proj');

    const chat = useChatStore.getState();
    // Workspace blank → next chat inherits nothing (default).
    expect(useWorkspaceStore.getState().rootPath).toBeNull();
    // Bindings untouched: the folder's stuff stays as it was.
    expect(chat.conversations.find((c) => c.id === 'c1')?.rootPath).toBe('/proj');
    expect(chat.conversations.find((c) => c.id === 'c2')?.rootPath).toBe('/proj');
    expect((window as any).electronAPI.conversation.update).not.toHaveBeenCalled();
    // Home default: no active chat, empty transcript.
    expect(chat.activeConversationId).toBeNull();
    expect(chat.messages).toEqual([]);
  });

  it('reopening a bound chat after closing brings the folder back', async () => {
    useChatStore.setState({
      conversations: [conv('c1', '/proj')],
      activeConversationId: null,
      messages: [],
    });
    useWorkspaceStore.setState({ rootPath: null });

    await useChatStore.getState().setActiveConversation('c1');

    expect(useWorkspaceStore.getState().rootPath).toBe('/proj');
    expect(useChatStore.getState().activeConversationId).toBe('c1');
  });

  it('ignores the no-folder group', async () => {
    useChatStore.setState({
      conversations: [conv('c1', null)],
      activeConversationId: 'c1',
      messages: [{ id: 'm', conversationId: 'c1', role: 'user', content: 'hi', createdAt: 0 } as any],
    });
    useWorkspaceStore.setState({ rootPath: '/proj' });

    await useChatStore.getState().closeFolderGroup('');

    expect(useWorkspaceStore.getState().rootPath).toBe('/proj');
    expect(useChatStore.getState().activeConversationId).toBe('c1');
  });
});
