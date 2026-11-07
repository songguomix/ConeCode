import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore, resetNativeToolFallback, retryTiming } from './chat.store';
import { useModelStore } from './model.store';
import { useSettingsStore } from './settings.store';
import { useWorkspaceStore } from './workspace.store';
import { useTodosStore } from './todos.store';
import { useMemoryStore } from './memory.store';
import { useCodeChangesStore } from './codeChanges.store';
import { defaultRsiState } from '../core/agents/rsiConversation';
import type { AIModel } from '../types';

// Transient failures (network drop, dead model stream) auto-retry with a
// visible pill on the live run; a user stop must never be overridden by a
// retry; exhausting every retry falls back to the manual one-click continue.

let streamCalls: any[];
let transcripts: Record<string, any[]>;

const model: AIModel = {
  id: 'gpt-test', name: 'GPT Test', providerId: 'p1',
  supportsText: true, supportsVision: false, supportsImageGeneration: false,
  supportsAudioInput: false, supportsAudioOutput: false,
  supportsFunctionCalling: true, supportsReasoning: false,
  contextWindow: 128000, maxOutputTokens: 8192, enabled: true,
};

const textResponse = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

function installStubs() {
  streamCalls = [];
  transcripts = {};
  (globalThis as any).window = {
    electronAPI: {
      chat: {
        stream: async (params: any) => { streamCalls.push(params); return textResponse('done'); },
        stop: async () => true,
      },
      message: {
        create: async (m: any) => { (transcripts[m.conversationId] ||= []).push(m); return m; },
        list: async (id: string) => transcripts[id] || [],
        delete: async () => true,
      },
      conversation: {
        create: async (d: any) => ({ id: 'conv-new', title: 'New Chat', createdAt: 0, updatedAt: 0, ...d }),
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
      },
      app: { getSystemInfo: async () => ({ platform: 'darwin' }) },
    },
  };
}

function resetStores(opts: { rsi?: boolean } = {}) {
  useModelStore.setState({ models: new Map([['p1', [model]]]), selectedModelId: 'gpt-test' });
  useSettingsStore.setState({ toolCallMode: 'auto', approvalMode: 'suggest', autoIncludeFileContext: false });
  useWorkspaceStore.setState({ rootPath: '/proj', mcpTools: [], contextFiles: [], selectedFile: null, fileContent: null, agentsMd: null });
  useTodosStore.getState().clearTodos();
  useChatStore.setState({
    messages: [],
    conversations: [{ id: 'conv1', title: 'One', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0,
      ...(opts.rsi ? { agentMode: 'rsi', rsi: defaultRsiState() } : {}) }],
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
  // Real defaults; individual tests shorten the waits.
  retryTiming.baseMs = 500;
}

beforeEach(() => {
  installStubs();
  resetNativeToolFallback();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetStores();
});

const assistantReplies = () =>
  (transcripts['conv1'] || []).filter((m) => m.role === 'assistant' && !m.isToolResult && !m.isLocalNotice);

describe('auto-retry on transient stream failures', () => {
  it('retries a dropped stream automatically with a visible pill, then completes', async () => {
    retryTiming.baseMs = 200;
    let attempts = 0;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      attempts += 1;
      if (attempts === 1) throw new Error('fetch failed: socket hang up');
      return textResponse('recovered reply');
    });

    const send = useChatStore.getState().sendMessage('hi', 'p1', 'gpt-test');

    // The reconnecting pill shows on the live run during the backoff window.
    await vi.waitFor(() => expect(useChatStore.getState().streamingRuns.conv1?.retry)
      .toEqual({ attempt: 1, max: 3 }));

    await send;
    expect(streamCalls).toHaveLength(2);
    const reply = assistantReplies()[0];
    expect(reply?.content).toBe('recovered reply');
    // A recovered turn is NOT an interruption — no manual continue is offered.
    expect(reply?.interrupted).toBeFalsy();
    expect(useChatStore.getState().streamingRuns.conv1).toBeUndefined();
    expect(useChatStore.getState().continuableConvId).toBeNull();
  });

  it('hides the interrupted attempt reasoning while reconnecting', async () => {
    retryTiming.baseMs = 200;
    let attempts = 0;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      attempts += 1;
      if (attempts === 1) {
        // Simulate reasoning + text that reached the live view before the drop.
        useChatStore.setState((s) => ({
          streamingRuns: {
            ...s.streamingRuns,
            conv1: {
              ...s.streamingRuns.conv1!,
              content: 'partial reply ',
              reasoningContent: 'reasoning from the dropped attempt',
              status: 'thinking',
            },
          },
        }));
        throw new Error('fetch failed: socket hang up');
      }
      return {
        choices: [{
          message: { role: 'assistant', content: 'recovered', reasoning_content: 'fresh reasoning' },
          finish_reason: 'stop',
        }],
      };
    });

    const send = useChatStore.getState().sendMessage('hi', 'p1', 'gpt-test');

    // The retry pill is live, but the interrupted attempt's thinking is gone
    // (the stitched reply text stays so the user keeps watching it arrive).
    await vi.waitFor(() => expect(useChatStore.getState().streamingRuns.conv1?.retry)
      .toEqual({ attempt: 1, max: 3 }));
    expect(useChatStore.getState().streamingRuns.conv1?.reasoningContent).toBe('');
    expect(useChatStore.getState().streamingRuns.conv1?.content).toBe('partial reply ');

    await send;
    const reply = assistantReplies()[0];
    expect(reply?.content).toBe('partial reply recovered');
    // Only the successful attempt's thinking is kept on the final message.
    expect(reply?.reasoning_content).toBe('fresh reasoning');
    expect(useChatStore.getState().streamingRuns.conv1).toBeUndefined();
  });

  it('retries the whole iteration with the turn budget after per-stream retries run out', async () => {
    retryTiming.baseMs = 30;
    // Every per-stream attempt fails: 3 inner attempts per budget round.
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      throw new Error('network unreachable');
    });

    const send = useChatStore.getState().sendMessage('hi', 'p1', 'gpt-test');

    // The retry pill keeps counting while the budget extends (4/6, 7/9 …).
    await vi.waitFor(() => {
      const retry = useChatStore.getState().streamingRuns.conv1?.retry;
      expect(retry?.attempt ?? 0).toBeGreaterThanOrEqual(4);
      expect(retry?.max ?? 0).toBeGreaterThanOrEqual(6);
    });

    await send;
    // 3 inner attempts × 3 iterations (initial + 2 turn retries) = 9, then the
    // run falls back to the persisted manual-continue affordance.
    expect(streamCalls).toHaveLength(9);
    expect(assistantReplies()).toHaveLength(0);
    expect(useChatStore.getState().continuableConvId).toBe('conv1');
    expect(useChatStore.getState().error).toBeTruthy();
    const notices = (transcripts['conv1'] || []).filter((m) => m.isLocalNotice);
    expect(notices.length).toBeGreaterThan(0);
  });

  it('never retries after the user pressed stop', async () => {
    retryTiming.baseMs = 200;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      throw new Error('fetch failed');
    });

    const send = useChatStore.getState().sendMessage('hi', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(useChatStore.getState().streamingRuns.conv1?.retry).toBeTruthy());

    // A stop during the backoff window must cancel the retry, not race it.
    useChatStore.getState().stopGeneration('conv1');
    await send;

    expect(streamCalls).toHaveLength(1);
    expect(useChatStore.getState().streamingRuns.conv1).toBeUndefined();
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('does not retry permanent failures (bad key, unknown model)', async () => {
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      throw new Error('401 Invalid API key');
    });

    await useChatStore.getState().sendMessage('hi', 'p1', 'gpt-test');

    expect(streamCalls).toHaveLength(1);
    expect(useChatStore.getState().error).toBeTruthy();
  });

  it.each([429, 500, 502, 503, 504])('retries a sanitized free-relay HTTP %s error across the IPC message boundary', async (status) => {
    retryTiming.baseMs = 1;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      if (streamCalls.length === 1) throw new Error(`ConeCode Free 暂时不可用，请稍后重试。 (HTTP ${status})`);
      return textResponse('recovered');
    });
    await useChatStore.getState().sendMessage('hi', 'p1', 'gpt-test');
    expect(streamCalls).toHaveLength(2);
    expect(assistantReplies()[0]?.content).toBe('recovered');
  });

  it('falls back to prompt tools when the free relay reports its safe unsupported-tools error', async () => {
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      if (streamCalls.length === 1) throw new Error('ConeCode Free: tools are not supported by this model. (HTTP 400)');
      return textResponse('done');
    });
    await useChatStore.getState().sendMessage('hi', 'p1', 'gpt-test');
    expect(streamCalls).toHaveLength(2);
    expect(streamCalls[0].tools?.length).toBeGreaterThan(0);
    expect(streamCalls[1].tools).toBeUndefined();
  });

  it('respects the advertised output limit for reasoning models', async () => {
    useModelStore.setState({ models: new Map([['p1', [{ ...model, supportsReasoning: true, maxOutputTokens: 8192 }]]]) });
    await useChatStore.getState().sendMessage('hi', 'p1', 'gpt-test');
    expect(streamCalls[0].maxTokens).toBe(8192);
  });
});

describe('RSI mode uses bounded retries', () => {
  it('stops after nine transient failures and records a failed execution', async () => {
    resetStores({ rsi: true });
    retryTiming.baseMs = 1;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      throw new Error('fetch failed');
    });

    await useChatStore.getState().sendMessage('run', 'p1', 'gpt-test', { rsiExecution: true });

    expect(streamCalls).toHaveLength(9);
    expect(assistantReplies()).toHaveLength(0);
    expect(useChatStore.getState().conversations[0].rsi?.runs[0].status).toBe('failed');
    expect(useChatStore.getState().continuableConvId).toBe('conv1');
  });

  it.each(['400 bad request', '401 Invalid API key'])('does not retry a permanent error: %s', async (error) => {
    resetStores({ rsi: true });
    retryTiming.baseMs = 1;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      throw new Error(error);
    });

    await useChatStore.getState().sendMessage('run', 'p1', 'gpt-test', { rsiExecution: true });

    expect(streamCalls).toHaveLength(1);
    expect(assistantReplies()).toHaveLength(0);
    expect(useChatStore.getState().conversations[0].rsi?.runs[0].status).toBe('failed');
  });

  it('stops retrying when the user presses stop', async () => {
    resetStores({ rsi: true });
    retryTiming.baseMs = 30;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      throw new Error('fetch failed');
    });

    const send = useChatStore.getState().sendMessage('hi', 'p1', 'gpt-test');
    await vi.waitFor(() => {
      expect((useChatStore.getState().streamingRuns.conv1?.retry?.attempt ?? 0) >= 2).toBe(true);
    });

    const callsAtStop = streamCalls.length;
    useChatStore.getState().stopGeneration('conv1');
    await send;

    // The stop is final: no further attempts fire and the run ends.
    expect(streamCalls.length).toBe(callsAtStop);
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().streamingRuns.conv1).toBeUndefined();
  });
});
