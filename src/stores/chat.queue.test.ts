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
        stop: vi.fn(async () => true),
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
        search: async () => ({ matches: [], capped: false }),
        glob: async () => ({ files: [], capped: false }),
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

  it('immediately drains multiple queued turns in FIFO order after completion', async () => {
    useChatStore.setState({ streamingRuns: { conv1: fakeRun() } });
    for (const content of ['first follow-up', 'second follow-up', 'third follow-up']) {
      useChatStore.getState().enqueueMessage('conv1', content, 'p1', 'gpt-test');
    }
    queued = [textResponse('first done'), textResponse('second done'), textResponse('third done')];
    useChatStore.setState({ streamingRuns: {} });
    await useChatStore.getState().flushQueue('conv1');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(3));
    expect(created.filter((m) => m.role === 'user' && !m.isToolResult).map((m) => m.content))
      .toEqual(['first follow-up', 'second follow-up', 'third follow-up']);
    expect(useChatStore.getState().queuedMessages.conv1).toHaveLength(0);
  });

  it('uses a steered message at the next model step, before ordinary follow-ups', async () => {
    let finish!: (result: any) => void;
    let finishSteered!: (result: any) => void;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      if (streamCalls.length === 1) return new Promise((resolve) => { finish = resolve; });
      if (streamCalls.length === 2) return new Promise((resolve) => { finishSteered = resolve; });
      return textResponse('follow-up complete');
    });
    const live = useChatStore.getState().sendMessage('original request', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(1));
    const store = useChatStore.getState();
    store.enqueueMessage('conv1', 'normal follow-up', 'p1', 'gpt-test');
    store.enqueueMessage('conv1', 'change direction', 'p1', 'gpt-test');
    store.steerQueuedMessage('conv1', useChatStore.getState().queuedMessages.conv1[1].id);
    expect(streamCalls).toHaveLength(1);
    finish(textResponse('first step complete'));

    await vi.waitFor(() => expect(streamCalls).toHaveLength(2));
    expect(streamCalls[1].messages.at(-2)).toMatchObject({ role: 'user', content: 'change direction' });
    expect(useChatStore.getState().queuedMessages.conv1.map((item) => item.content)).toEqual(['normal follow-up']);
    expect(window.electronAPI.chat.stop).not.toHaveBeenCalled();
    finishSteered(textResponse('updated direction complete'));
    await live;
    await vi.waitFor(() => expect(streamCalls).toHaveLength(3));
    expect(created.filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual(['original request', 'change direction', 'normal follow-up']);
  });

  it('keeps the exact steer write failure visible without sending the message again', async () => {
    let finish!: (result: any) => void;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      return new Promise((resolve) => { finish = resolve; });
    });
    const create = window.electronAPI.message.create;
    const write = vi.fn(async (message: any) => {
      if (message.content === 'cannot write') throw new Error('Disk is full');
      return create(message);
    });
    window.electronAPI.message.create = write;
    const live = useChatStore.getState().sendMessage('original request', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(1));
    const store = useChatStore.getState();
    store.enqueueMessage('conv1', 'cannot write', 'p1', 'gpt-test');
    store.steerQueuedMessage('conv1', useChatStore.getState().queuedMessages.conv1[0].id);
    finish(textResponse('first step complete'));
    await live;
    await store.flushQueue('conv1');
    expect(streamCalls).toHaveLength(1);
    expect(write.mock.calls.filter(([message]) => message.content === 'cannot write')).toHaveLength(1);
    expect(useChatStore.getState().queuedMessages.conv1).toMatchObject([{ content: 'cannot write', steer: false, steerError: 'Disk is full' }]);
  });

  it('serializes concurrent flushes while the first queued response is pending', async () => {
    useChatStore.setState({ streamingRuns: { conv1: fakeRun() } });
    useChatStore.getState().enqueueMessage('conv1', 'first', 'p1', 'gpt-test');
    useChatStore.getState().enqueueMessage('conv1', 'second', 'p1', 'gpt-test');
    useChatStore.setState({ streamingRuns: {} });
    let finish!: (value: any) => void;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      if (streamCalls.length === 1) return await new Promise((resolve) => { finish = resolve; });
      return textResponse('done');
    });
    const firstFlush = useChatStore.getState().flushQueue('conv1');
    const secondFlush = useChatStore.getState().flushQueue('conv1');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(1));
    expect(useChatStore.getState().queuedMessages.conv1.map((m) => m.content)).toEqual(['second']);
    finish(textResponse('first done'));
    await Promise.all([firstFlush, secondFlush]);
    expect(streamCalls).toHaveLength(2);
    expect(created.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('holds the queue while approval or an answer is owed', async () => {
    useChatStore.setState({ streamingRuns: { conv1: fakeRun() } });
    useChatStore.getState().enqueueMessage('conv1', 'wait for it', 'p1', 'gpt-test');
    useChatStore.getState().steerQueuedMessage('conv1', useChatStore.getState().queuedMessages.conv1[0].id);
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

  it('leaves queued messages intact when it cannot check for an unanswered question', async () => {
    useChatStore.setState({ streamingRuns: { conv1: fakeRun() } });
    useChatStore.getState().enqueueMessage('conv1', 'follow-up', 'p1', 'gpt-test');
    useChatStore.setState({ streamingRuns: {} });
    window.electronAPI.message.list = vi.fn().mockRejectedValue(new Error('Unable to read conversation'));

    await useChatStore.getState().flushQueue('conv1');

    expect(useChatStore.getState().error).toBe('Unable to read conversation');
    expect(useChatStore.getState().queuedMessages.conv1).toHaveLength(1);
    expect(streamCalls).toHaveLength(0);
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

  it('never drags the composer image into a queued turn', async () => {
    const pastedImage = {
      path: 'pasted-image.png',
      content: '',
      isImage: true,
      dataUrl: 'data:image/png;base64,AAAA',
    };
    useWorkspaceStore.setState({ contextFiles: [pastedImage] });
    useChatStore.setState({ streamingRuns: { conv1: fakeRun() } });
    expect(useChatStore.getState().enqueueMessage('conv1', 'queued text only', 'p1', 'gpt-test')).toBe('queued');

    queued = [textResponse('done')];
    useChatStore.setState({ streamingRuns: {} });
    await useChatStore.getState().flushQueue('conv1');

    const userMsg = created.find((m) => m.role === 'user' && m.content === 'queued text only');
    expect(userMsg).toBeTruthy();
    expect(userMsg.images).toBeUndefined();
    // The image stays in the composer, ready for the user's own next send.
    expect(useWorkspaceStore.getState().contextFiles).toEqual([pastedImage]);
  });

  it('still sends the composer image with the turn the user actually sends', async () => {
    const pastedImage = {
      path: 'pasted-image.png',
      content: '',
      isImage: true,
      dataUrl: 'data:image/png;base64,AAAA',
    };
    useWorkspaceStore.setState({ contextFiles: [pastedImage] });
    queued = [textResponse('described')];
    await useChatStore.getState().sendMessage('what is this?', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(1));

    const userMsg = created.find((m) => m.role === 'user' && m.content === 'what is this?');
    expect(userMsg.images).toEqual(['data:image/png;base64,AAAA']);
    expect(useWorkspaceStore.getState().contextFiles).toEqual([]);
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
