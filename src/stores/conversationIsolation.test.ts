import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from './chat.store';
import { useUIStore } from './ui.store';
import { useWorkspaceStore } from './workspace.store';
import { useModelStore } from './model.store';
import { isChatConversation, isWorkConversation, groupConversationsByFolder } from '../core/workspace/conversations';
import { isRsiConversation, defaultRsiState } from '../core/agents/rsiConversation';
import type { Conversation, Message } from '../types';

let createdConvs: any[];
let updatedConvs: any[];

function installStubs() {
  createdConvs = [];
  updatedConvs = [];
  (globalThis as any).window = {
    electronAPI: {
      conversation: {
        create: vi.fn(async (data: any) => {
          const conv = { id: `conv-${createdConvs.length + 1}`, title: 'New Conversation', createdAt: Date.now(), updatedAt: Date.now(), ...data };
          createdConvs.push(conv);
          return conv;
        }),
        update: vi.fn(async (id: string, data: any) => {
          updatedConvs.push({ id, data });
        }),
        setArchived: vi.fn(async (id: string, archived: boolean) => {
          const conversation = useChatStore.getState().conversations.find((c) => c.id === id);
          return conversation ? { ...conversation, archivedAt: archived ? Date.now() : null } : null;
        }),
        delete: vi.fn(async () => true),
        list: vi.fn(async () => []),
      },
      message: {
        list: vi.fn(async () => []),
        create: vi.fn(async (m: any) => m),
      },
      fs: {
        stat: vi.fn(async () => ({ isDirectory: true, isFile: false })),
        readDir: vi.fn(async () => []),
        readFile: vi.fn(async () => null),
      },
      app: { getSystemInfo: vi.fn(async () => ({})) },
    },
  };
}

beforeEach(() => {
  installStubs();
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    agentMode: 'standard',
    workspaceSnapshots: new Map(),
  });
  useUIStore.setState({ viewMode: 'chat' });
  useWorkspaceStore.setState({ rootPath: '/workspace/project', files: [], extraRoots: [] });
  useModelStore.setState({ models: new Map(), selectedModelId: 'test-model' });
});

describe('Conversation archiving', () => {
  const conversation: Conversation = {
    id: 'chat-1', title: 'Chat', providerId: 'p1', modelId: 'm1',
    rootPath: null, isChatMode: true, createdAt: 1, updatedAt: 1,
  };
  const message: Message = { id: 'first', conversationId: conversation.id, role: 'user', content: 'Keep me', createdAt: 1 };

  it('clears the active view while keeping the archived transcript available to open and restore', async () => {
    useChatStore.setState({ conversations: [conversation], activeConversationId: conversation.id, messages: [message] });
    vi.mocked(window.electronAPI.message.list).mockResolvedValue([message]);

    await useChatStore.getState().setConversationArchived(conversation.id, true);
    expect(useChatStore.getState()).toMatchObject({
      activeConversationId: null,
      messages: [],
      conversations: [{ ...conversation, archivedAt: expect.any(Number) }],
    });
    expect(useChatStore.getState().workspaceSnapshots.has(conversation.id)).toBe(true);
    expect(window.electronAPI.conversation.delete).not.toHaveBeenCalled();

    await useChatStore.getState().setActiveConversation(conversation.id);
    expect(useChatStore.getState().messages).toEqual([message]);
    await useChatStore.getState().setConversationArchived(conversation.id, false);
    expect(useChatStore.getState().conversations).toEqual([{ ...conversation, archivedAt: null }]);
    expect(useChatStore.getState().activeConversationId).toBe(conversation.id);
  });

  it('leaves the active view intact when archiving fails', async () => {
    useChatStore.setState({ conversations: [conversation], activeConversationId: conversation.id, messages: [message] });
    vi.mocked(window.electronAPI.conversation.setArchived).mockRejectedValueOnce(new Error('write failed'));

    await expect(useChatStore.getState().setConversationArchived(conversation.id, true)).rejects.toThrow('write failed');
    expect(useChatStore.getState()).toMatchObject({
      activeConversationId: conversation.id,
      messages: [message],
      conversations: [conversation],
    });
  });

  it('does not activate a conversation archived while its transcript is loading', async () => {
    useChatStore.setState({ conversations: [conversation] });
    let finishLoading!: (messages: Message[]) => void;
    vi.mocked(window.electronAPI.message.list).mockReturnValueOnce(new Promise((resolve) => { finishLoading = resolve; }));

    const opening = useChatStore.getState().setActiveConversation(conversation.id);
    await useChatStore.getState().setConversationArchived(conversation.id, true);
    finishLoading([message]);
    await opening;

    expect(useChatStore.getState().activeConversationId).toBeNull();
    expect(useChatStore.getState().messages).toEqual([]);
  });
});

describe('Conversation Area Mode Isolation', () => {
  it('creates chat-mode conversations when in chat viewMode', async () => {
    useUIStore.setState({ viewMode: 'chat' });
    const id = await useChatStore.getState().createConversation('p1', 'm1', null);
    const conv = useChatStore.getState().conversations.find((c) => c.id === id);

    expect(conv).toBeDefined();
    expect(conv?.rootPath).toBeNull();
    expect(conv?.isChatMode).toBe(true);
    expect(isChatConversation(conv!)).toBe(true);
    expect(isWorkConversation(conv!)).toBe(false);
    expect(isRsiConversation(conv!)).toBe(false);
  });

  it('creates work-mode conversations bound to rootPath in work viewMode', async () => {
    useUIStore.setState({ viewMode: 'work' });
    const id = await useChatStore.getState().createConversation('p1', 'm1', '/workspace/project');
    const conv = useChatStore.getState().conversations.find((c) => c.id === id);

    expect(conv).toBeDefined();
    expect(conv?.rootPath).toBe('/workspace/project');
    expect(conv?.isChatMode).toBe(false);
    expect(isWorkConversation(conv!)).toBe(true);
    expect(isChatConversation(conv!)).toBe(false);
    expect(isRsiConversation(conv!)).toBe(false);
  });

  it('shows the Work list when opening a project starts a conversation from Chat', async () => {
    await useChatStore.getState().newConversation('p1', 'm1', '/workspace/project');

    expect(useChatStore.getState().conversations).toHaveLength(1);
    expect(isWorkConversation(useChatStore.getState().conversations[0])).toBe(true);
    expect(useUIStore.getState().viewMode).toBe('work');
  });

  it('reopens a saved Work conversation without a project in its own view', async () => {
    const saved: Conversation = {
      id: 'without-project', title: 'First message', providerId: 'p1', modelId: 'm1',
      rootPath: null, isChatMode: false, createdAt: 1, updatedAt: 1,
    };
    const first: Message = { id: 'm', role: 'user', content: saved.title, conversationId: saved.id, createdAt: 1 };
    vi.mocked(window.electronAPI.conversation.list).mockResolvedValue([saved]);
    vi.mocked(window.electronAPI.message.list).mockResolvedValue([first]);

    await useChatStore.getState().fetchConversations();
    await useChatStore.getState().setActiveConversation(saved.id);

    expect(useUIStore.getState().viewMode).toBe('work');
    expect(useChatStore.getState().activeConversationId).toBe(saved.id);
    expect(useChatStore.getState().messages).toEqual([first]);
  });

  it('creates dedicated RSI conversations and switches viewMode to work', async () => {
    const id = await useChatStore.getState().createRsiConversation('p1', 'm1');
    const conv = useChatStore.getState().conversations.find((c) => c.id === id);

    expect(conv).toBeDefined();
    expect(conv?.agentMode).toBe('rsi');
    expect(conv?.rsi).toBeDefined();
    expect(useUIStore.getState().viewMode).toBe('work');
    expect(useChatStore.getState().agentMode).toBe('rsi');
    expect(isRsiConversation(conv!)).toBe(true);
    expect(isChatConversation(conv!)).toBe(false);
    expect(isWorkConversation(conv!)).toBe(false);
  });

  it('automatically aligns viewMode when switching active conversations', async () => {
    const chatConv: Conversation = {
      id: 'chat-1', title: 'Chat', providerId: 'p1', modelId: 'm1',
      rootPath: null, isChatMode: true, createdAt: 1, updatedAt: 1,
    };
    const workConv: Conversation = {
      id: 'work-1', title: 'Work', providerId: 'p1', modelId: 'm1',
      rootPath: '/workspace/project', isChatMode: false, createdAt: 2, updatedAt: 2,
    };
    const rsiConv: Conversation = {
      id: 'rsi-1', title: 'RSI', providerId: 'p1', modelId: 'm1',
      rootPath: '/workspace/project', isChatMode: false, agentMode: 'rsi',
      rsi: defaultRsiState(), createdAt: 3, updatedAt: 3,
    };

    useChatStore.setState({ conversations: [chatConv, workConv, rsiConv] });

    await useChatStore.getState().setActiveConversation('chat-1');
    expect(useUIStore.getState().viewMode).toBe('chat');
    expect(useChatStore.getState().agentMode).toBe('standard');

    await useChatStore.getState().setActiveConversation('work-1');
    expect(useUIStore.getState().viewMode).toBe('work');
    expect(useChatStore.getState().agentMode).toBe('standard');

    await useChatStore.getState().setActiveConversation('rsi-1');
    expect(useUIStore.getState().viewMode).toBe('work');
    expect(useChatStore.getState().agentMode).toBe('rsi');
  });

  it('exiting RSI mode cleanly switches active conversation to non-RSI conversation', async () => {
    const workConv: Conversation = {
      id: 'work-1', title: 'Work', providerId: 'p1', modelId: 'm1',
      rootPath: '/workspace/project', isChatMode: false, createdAt: 2, updatedAt: 2,
    };
    const rsiConv: Conversation = {
      id: 'rsi-1', title: 'RSI', providerId: 'p1', modelId: 'm1',
      rootPath: '/workspace/project', isChatMode: false, agentMode: 'rsi',
      rsi: defaultRsiState(), createdAt: 3, updatedAt: 3,
    };

    useChatStore.setState({
      conversations: [rsiConv, workConv],
      activeConversationId: 'rsi-1',
      agentMode: 'rsi',
    });
    useUIStore.setState({ viewMode: 'work' });

    useChatStore.getState().setAgentMode('standard');
    await new Promise((r) => setTimeout(r, 20));

    expect(useChatStore.getState().agentMode).toBe('standard');
    // Active conversation must switch away from RSI to work conversation
    expect(useChatStore.getState().activeConversationId).toBe('work-1');
  });

  it('groups RSI conversations under their bound workspace rootPath', () => {
    const rsi1: Conversation = {
      id: 'rsi-1', title: 'RSI 1', providerId: 'p1', modelId: 'm1',
      rootPath: '/workspace/conecode', isChatMode: false, agentMode: 'rsi',
      rsi: defaultRsiState(), createdAt: 1, updatedAt: 1,
    };
    const rsi2: Conversation = {
      id: 'rsi-2', title: 'RSI 2', providerId: 'p1', modelId: 'm1',
      rootPath: '/workspace/conecode', isChatMode: false, agentMode: 'rsi',
      rsi: defaultRsiState(), createdAt: 2, updatedAt: 2,
    };
    const rsiGroups = groupConversationsByFolder([rsi1, rsi2], '/workspace/conecode');
    expect(rsiGroups.length).toBe(1);
    expect(rsiGroups[0][0]).toBe('/workspace/conecode');
    expect(rsiGroups[0][1].length).toBe(2);
  });
});
