import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from './chat.store';
import { useUIStore } from './ui.store';
import { useWorkspaceStore } from './workspace.store';
import { useModelStore } from './model.store';
import { useMemoryV2Store } from './memoryV2.store';
import { defaultRsiState } from '../core/agents/rsiConversation';
import type { Conversation, Message } from '../types';

// New-chat actions must reuse an existing blank conversation instead of
// stacking another "New Chat" row. These tests pin the store-level contract;
// the pure selection rules live in core/workspace/conversations.test.ts.

let created: any[];
let counts: Record<string, number>;

function installStubs() {
  created = [];
  counts = {};
  (globalThis as any).window = {
    electronAPI: {
      conversation: {
        create: vi.fn(async (data: any) => {
          const conv = {
            id: `new-${created.length + 1}`,
            title: 'New Chat',
            createdAt: 0,
            updatedAt: 0,
            ...data,
          };
          created.push(conv);
          return conv;
        }),
        update: vi.fn(async () => undefined),
        delete: vi.fn(async () => true),
        list: vi.fn(async () => []),
      },
      message: {
        list: vi.fn(async () => []),
        counts: vi.fn(async () => counts),
        create: vi.fn(async (message: any) => message),
        delete: vi.fn(async () => true),
      },
      fs: {
        stat: vi.fn(async () => ({ isDirectory: true, isFile: false })),
        readDir: vi.fn(async () => []),
        readFile: vi.fn(async () => null),
        createDir: vi.fn(async () => true),
        writeFile: vi.fn(async () => true),
      },
      app: { getSystemInfo: vi.fn(async () => ({ platform: 'darwin' })) },
      notification: { show: vi.fn(async () => true) },
    },
  };
}

const blankChat = (id: string, updatedAt = 1): Conversation => ({
  id,
  title: 'New Chat',
  providerId: 'p1',
  modelId: 'm1',
  rootPath: null,
  isChatMode: true,
  createdAt: updatedAt,
  updatedAt,
});

const usedChat = (id: string, updatedAt = 1): Conversation => ({
  ...blankChat(id, updatedAt),
  title: 'Used chat',
});

const message = (conversationId: string): Message => ({
  id: `m-${conversationId}`,
  conversationId,
  role: 'user',
  content: 'hello',
  createdAt: 1,
});

beforeEach(() => {
  installStubs();
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    isStreaming: false,
    streamingRuns: {},
    queuedMessages: {},
    messageEdits: {},
    workspaceSnapshots: new Map(),
    agentMode: 'standard',
    error: null,
  });
  useUIStore.setState({ viewMode: 'chat' });
  useWorkspaceStore.setState({ rootPath: null, files: [], extraRoots: [] });
  useModelStore.setState({ models: new Map(), selectedModelId: null, selectedProviderId: null });
  useMemoryV2Store.setState({ active: false, initialized: true });
});

describe('newConversation reuses blank chats', () => {
  it('keeps the active blank conversation instead of creating another', async () => {
    useChatStore.setState({
      conversations: [blankChat('active')],
      activeConversationId: 'active',
      messages: [],
    });
    counts = { active: 0 };

    const id = await useChatStore.getState().newConversation('p1', 'm1', null);

    expect(id).toBe('active');
    expect(created).toHaveLength(0);
  });

  it('activates an inactive blank conversation instead of creating another', async () => {
    useChatStore.setState({
      conversations: [usedChat('used'), blankChat('blank', 2)],
      activeConversationId: 'used',
      messages: [message('used')],
    });
    counts = { used: 1, blank: 0 };

    const id = await useChatStore.getState().newConversation('p1', 'm1', null);

    expect(id).toBe('blank');
    expect(created).toHaveLength(0);
    expect(useChatStore.getState().activeConversationId).toBe('blank');
  });

  it('creates a conversation when every candidate has messages', async () => {
    useChatStore.setState({
      conversations: [usedChat('used')],
      activeConversationId: 'used',
      messages: [message('used')],
    });
    counts = { used: 1 };

    const id = await useChatStore.getState().newConversation('p1', 'm1', null);

    expect(id).not.toBe('used');
    expect(created).toHaveLength(1);
    expect(useChatStore.getState().activeConversationId).toBe(id);
  });

  it('does not reuse a blank conversation from another mode or folder', async () => {
    const workBlank: Conversation = {
      ...blankChat('work', 2),
      rootPath: '/proj',
      isChatMode: false,
    };
    useChatStore.setState({
      conversations: [workBlank],
      activeConversationId: null,
      messages: [],
    });
    counts = { work: 0 };

    const id = await useChatStore.getState().newConversation('p1', 'm1', null);

    expect(id).not.toBe('work');
    expect(created).toHaveLength(1);
  });

  it('coalesces two rapid new-chat calls into one conversation', async () => {
    useChatStore.setState({ conversations: [], activeConversationId: null, messages: [] });
    counts = {};

    const [first, second] = await Promise.all([
      useChatStore.getState().newConversation('p1', 'm1', null),
      useChatStore.getState().newConversation('p1', 'm1', null),
    ]);

    expect(first).toBe(second);
    expect(created).toHaveLength(1);
  });

  it('reuses a blank Work conversation bound to the same folder', async () => {
    const workBlank: Conversation = {
      ...blankChat('work', 2),
      rootPath: '/proj',
      isChatMode: false,
    };
    useChatStore.setState({
      conversations: [workBlank],
      activeConversationId: null,
      messages: [],
    });
    useUIStore.setState({ viewMode: 'work' });
    useWorkspaceStore.setState({ rootPath: '/proj' });
    counts = { work: 0 };

    const id = await useChatStore.getState().newConversation('p1', 'm1', '/proj');

    expect(id).toBe('work');
    expect(created).toHaveLength(0);
    expect(useChatStore.getState().activeConversationId).toBe('work');
  });
});

describe('newRsiConversation reuses blank RSI sessions', () => {
  it('activates a blank RSI conversation in the same workspace', async () => {
    const rsiBlank: Conversation = {
      ...blankChat('rsi', 2),
      isChatMode: false,
      agentMode: 'rsi',
      rsi: defaultRsiState(),
    };
    useChatStore.setState({
      conversations: [rsiBlank],
      activeConversationId: null,
      messages: [],
    });
    counts = { rsi: 0 };

    const id = await useChatStore.getState().newRsiConversation('p1', 'm1');

    expect(id).toBe('rsi');
    expect(created).toHaveLength(0);
    expect(useChatStore.getState().activeConversationId).toBe('rsi');
    expect(useChatStore.getState().agentMode).toBe('rsi');
    expect(useUIStore.getState().viewMode).toBe('work');
  });
});

describe('entering RSI mode reopens an existing session', () => {
  it('prefers the newest RSI conversation over creating a new one', async () => {
    const plain = usedChat('plain', 3);
    const older: Conversation = {
      ...blankChat('older', 1),
      isChatMode: false,
      agentMode: 'rsi',
      rsi: {
        ...defaultRsiState(),
        runs: [{ id: 'run', status: 'completed', iteration: 1, result: null, createdAt: 1, updatedAt: 1 }],
      },
    };
    const newer: Conversation = {
      ...blankChat('newer', 2),
      isChatMode: false,
      agentMode: 'rsi',
      rsi: defaultRsiState(),
    };
    useChatStore.setState({
      conversations: [plain, older, newer],
      activeConversationId: 'plain',
      messages: [message('plain')],
      agentMode: 'standard',
    });
    counts = { plain: 1, older: 1, newer: 0 };

    useChatStore.getState().setAgentMode('rsi');
    await vi.waitFor(() => expect(useChatStore.getState().activeConversationId).toBe('newer'));

    expect(created).toHaveLength(0);
    expect(useChatStore.getState().agentMode).toBe('rsi');
  });
});
