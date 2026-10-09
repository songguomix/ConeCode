import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from './chat.store';
import { useWorkspaceStore } from './workspace.store';

function installStubs() {
  (globalThis as any).window = {
    electronAPI: {
      dialog: { openFolder: async () => '/new' },
      conversation: {
        create: vi.fn(async (c: any) => ({
          id: 'fresh', title: 'New Chat', createdAt: 0, updatedAt: 0, ...c,
        })),
        update: vi.fn(async () => ({})),
      },
      message: { list: async () => [] },
      app: { getSystemInfo: async () => ({ homedir: '/home/test' }) },
      fs: {
        stat: async () => ({ isDirectory: true }),
        readDir: async () => [],
        readFile: async () => null,
        readFileBase64: async () => null,
      },
    },
  };
}

beforeEach(() => {
  installStubs();
  useChatStore.setState({
    conversations: [
      { id: 'old', title: 'Old', providerId: 'p1', modelId: 'm1', createdAt: 0, updatedAt: 0, rootPath: '/old' },
    ],
    activeConversationId: 'old',
    messages: [],
    workspaceSnapshots: new Map(),
  });
  useWorkspaceStore.setState({
    rootPath: '/old',
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

describe('openFolder (picking a new folder)', () => {
  it('immediately starts a new conversation bound to that folder', async () => {
    await useWorkspaceStore.getState().openFolder();

    const chat = useChatStore.getState();
    // A fresh chat was created and activated (empty transcript → home).
    expect((window as any).electronAPI.conversation.create).toHaveBeenCalled();
    expect(chat.activeConversationId).toBe('fresh');
    expect(chat.messages).toEqual([]);
    // The new folder is open and bound to the fresh chat, not the old one.
    expect(useWorkspaceStore.getState().rootPath).toBe('/new');
    expect((window as any).electronAPI.conversation.update).toHaveBeenCalledWith(
      'fresh', expect.objectContaining({ rootPath: '/new' }),
    );
    const old = chat.conversations.find((c) => c.id === 'old');
    expect(old?.rootPath).toBe('/old');
  });

  it('keeps the old workspace snapshot on the previous chat', async () => {
    await useWorkspaceStore.getState().openFolder();

    // Switching back restores the old folder, not the new one.
    const snap = useChatStore.getState().workspaceSnapshots.get('old');
    expect(snap?.rootPath).toBe('/old');
  });
});
