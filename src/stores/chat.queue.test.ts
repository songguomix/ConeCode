import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore, resetNativeToolFallback } from './chat.store';
import { useModelStore } from './model.store';
import { useSettingsStore } from './settings.store';
import { useWorkspaceStore } from './workspace.store';
import { useTodosStore } from './todos.store';
import { useMemoryStore } from './memory.store';
import { useCodeChangesStore } from './codeChanges.store';
import type { AIModel } from '../types';

// opencode-style follow-ups: typed mid-run, sent when the turn ends.

let streamCalls: any[];
let queued: any[];
let created: any[];
let transcripts: Record<string, any[]>;

const model: AIModel = {
  id: 'gpt-test', name: 'GPT Test', providerId: 'p1',
  supportsText: true, supportsVision: false, supportsImageGeneration: false,
  supportsAudioInput: false, supportsAudioOutput: false,
  supportsFunctionCalling: true, supportsReasoning: false,
  contextWindow: 128000, maxOutputTokens: 8192, enabled: true,
};

const textResponse = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const fakeRun = () => ({ content: '', reasoningContent: '', status: 'thinking', toolName: null }) as any;

function installStubs() {
  streamCalls = [];
  queued = [];
  created = [];
  transcripts = {};
  (globalThis as any).window = {
    electronAPI: {
      chat: {
        stream: async (params: any) => {
          streamCalls.push(params);
          return queued.shift() ?? textResponse('done');
        },
        stop: async () => true,
      },
      message: {
        create: async (m: any) => {
          created.push(m);
          (transcripts[m.conversationId] ||= []).push(m);
          return m;
        },
        list: async (id: string) => transcripts[id] || [],
        delete: async () => true,
      },
      conversation: {
        create: async (d: any) => ({ id: 'conv-new', title: 'New Chat', ...d, createdAt: 0, updatedAt: 0 }),
        update: async () => {},
        list: async () => [],
      },
      notification: { show: vi.fn(async () => true) },
      fs: {
        readFile: async () => null,
        writeFile: async () => true,
        readDir: async () => [],
        exists: async () => false,
        createDir: async () => true,
        stat: async () => ({ size: 1, isDirectory: false, isFile: true, createdAt: '', modifiedAt: '' }),
        search: async () => [],
        glob: async () => [],
      },
      git: { status: async () => '', diff: async () => '' },
      net: { fetch: async () => '', search: async () => '', download: async () => '' },
      mcp: { call: async () => 'mcp ok' },
      app: { getSystemInfo: async () => ({ platform: 'darwin' }) },
    },
  };
}

function resetStores() {
  useModelStore.setState({ models: new Map([['p1', [model]]]), selectedModelId: 'gpt-test' });
  useSettingsStore.setState({ toolCallMode: 'auto', approvalMode: 'suggest', autoIncludeFileContext: false });
  useWorkspaceStore.setState({ rootPath: '/proj', mcpTools: [], contextFiles: [], selectedFile: null, fileContent: null, agentsMd: null });
  useTodosStore.getState().clearTodos();
  useChatStore.setState({
    messages: [],
    conversations: [{ id: 'conv1', title: 'One', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 }],
    activeConversationId: 'conv1',
    isStreaming: false,
    planMode: false,
    error: null,
    messageEdits: {},
    streamingRuns: {},
    queuedMessages: {},
  });
  useMemoryStore.setState({ entries: [], enabled: false, extracting: false, loaded: true });
  useCodeChangesStore.setState({ changes: [] });
}

describe('mid-run message queue', () => {
  beforeEach(() => {
    installStubs();
    resetNativeToolFallback();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    resetStores();
  });

  it('queues while streaming and sends when the run ends', async () => {
    useChatStore.setState({ streamingRuns: { conv1: fakeRun() } });
    const verdict = useChatStore.getState().enqueueMessage('conv1', 'and another thing', 'p1', 'gpt-test');
    expect(verdict).toBe('queued');
    expect(streamCalls).toHaveLength(0);
    expect(useChatStore.getState().queuedMessages.conv1).toHaveLength(1);

    queued = [textResponse('follow-up done')];
    useChatStore.setState({ streamingRuns: {} });
    await useChatStore.getState().flushQueue('conv1');
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].conversationId).toBe('conv1');
    expect(created.some((m) => m.content === 'and another thing')).toBe(true);
    expect(useChatStore.getState().queuedMessages.conv1).toHaveLength(0);
  });

  it('flushes automatically through endRun (stop path)', async () => {
    queued = [textResponse('after stop')];
    useChatStore.setState({ streamingRuns: { conv1: fakeRun() } });
    useChatStore.getState().enqueueMessage('conv1', 'queued behind stop', 'p1', 'gpt-test');
    useChatStore.getState().stopGeneration('conv1');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(1));
    expect(created.some((m) => m.content === 'queued behind stop')).toBe(true);
  });

  it('holds the queue while approval or an answer is owed', async () => {
    useChatStore.setState({ streamingRuns: { conv1: fakeRun() } });
    useChatStore.getState().enqueueMessage('conv1', 'wait for it', 'p1', 'gpt-test');
    useChatStore.setState({ streamingRuns: {} });
    useCodeChangesStore.setState({
      changes: [{
        id: 'c1', kind: 'edit', filePath: '/proj/a.ts', originalCode: 'o', newCode: 'n',
        description: '', status: 'pending', createdAt: 1, conversationId: 'conv1', messageId: 'm',
      }] as any,
    });
    await useChatStore.getState().flushQueue('conv1');
    expect(streamCalls).toHaveLength(0);
    expect(useChatStore.getState().queuedMessages.conv1).toHaveLength(1);

    useCodeChangesStore.setState({ changes: [] });
    transcripts.conv1 = [{ id: 'q', conversationId: 'conv1', role: 'assistant', content: 'pick one', isQuestion: true, createdAt: 2 }];
    await useChatStore.getState().flushQueue('conv1');
    expect(streamCalls).toHaveLength(0);
    expect(useChatStore.getState().queuedMessages.conv1).toHaveLength(1);
  });

  it('drops the queue with a deleted conversation and never double-sends', async () => {
    useChatStore.setState({
      streamingRuns: { conv1: fakeRun() },
      conversations: [],
    });
    // enqueue needs the conversation to exist — re-add, queue, then delete.
    useChatStore.setState({
      conversations: [{ id: 'conv1', title: 'One', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 }],
    });
    useChatStore.getState().enqueueMessage('conv1', 'orphan', 'p1', 'gpt-test');
    useChatStore.setState({ conversations: [], streamingRuns: {} });
    await useChatStore.getState().flushQueue('conv1');
    expect(streamCalls).toHaveLength(0);
    expect(useChatStore.getState().queuedMessages.conv1).toBeUndefined();

    // A live run always wins over the queue.
    useChatStore.setState({
      conversations: [{ id: 'conv1', title: 'One', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 }],
      streamingRuns: { conv1: fakeRun() },
    });
    useChatStore.getState().enqueueMessage('conv1', 'later', 'p1', 'gpt-test');
    await useChatStore.getState().flushQueue('conv1');
    expect(streamCalls).toHaveLength(0);
    expect(useChatStore.getState().queuedMessages.conv1).toHaveLength(1);
  });

  it('delivers straight away on the streaming race and dequeues by id', async () => {
    queued = [textResponse('race reply')];
    const verdict = useChatStore.getState().enqueueMessage('conv1', 'already free', 'p1', 'gpt-test');
    expect(verdict).toBe('sent');
    // deliver is async — wait for the run it started.
    await vi.waitFor(() => expect(streamCalls).toHaveLength(1));
    expect(useChatStore.getState().queuedMessages.conv1 || []).toHaveLength(0);

    useChatStore.setState({ streamingRuns: { conv1: fakeRun() } });
    useChatStore.getState().enqueueMessage('conv1', 'keep', 'p1', 'gpt-test');
    useChatStore.getState().enqueueMessage('conv1', 'drop', 'p1', 'gpt-test');
    const dropId = useChatStore.getState().queuedMessages.conv1[1].id;
    useChatStore.getState().dequeueMessage('conv1', dropId);
    expect(useChatStore.getState().queuedMessages.conv1.map((m) => m.content)).toEqual(['keep']);
  });
});
