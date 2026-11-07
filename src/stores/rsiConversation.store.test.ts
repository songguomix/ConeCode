import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore, beginRsiRun, finalizeRsiRun, resetNativeToolFallback } from './chat.store';
import { useModelStore } from './model.store';
import { useSettingsStore } from './settings.store';
import { useWorkspaceStore } from './workspace.store';
import { useTodosStore } from './todos.store';
import { useMemoryStore } from './memory.store';
import { useCodeChangesStore } from './codeChanges.store';
import { useUIStore } from './ui.store';
import { defaultRsiState } from '../core/agents/rsiConversation';
import type { AIModel, Conversation } from '../types';

// Dedicated RSI conversations: per-session direction state, isolated run
// records, and a protocol that follows the conversation — not the UI.

let streamCalls: any[];
let conversationCreates: any[];
let conversationUpdates: Array<{ id: string; data: any }>;
let transcripts: Record<string, any[]>;

const model: AIModel = {
  id: 'gpt-test', name: 'GPT Test', providerId: 'p1',
  supportsText: true, supportsVision: false, supportsImageGeneration: false,
  supportsAudioInput: false, supportsAudioOutput: false,
  supportsFunctionCalling: true, supportsReasoning: false,
  contextWindow: 128000, maxOutputTokens: 8192, enabled: true,
};

const textResponse = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

/** A persisted RSI conversation record as the storage layer would return it. */
function rsiConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'rsi-1', title: 'RSI One', providerId: 'p1', modelId: 'gpt-test',
    rootPath: '/proj', createdAt: 0, updatedAt: 0,
    agentMode: 'rsi', rsi: defaultRsiState(),
    ...overrides,
  } as Conversation;
}

function installStubs() {
  streamCalls = [];
  conversationCreates = [];
  conversationUpdates = [];
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
        create: async (d: any) => {
          conversationCreates.push(d);
          return { id: 'rsi-new', title: 'New Chat', createdAt: 0, updatedAt: 0, ...d };
        },
        update: async (id: string, data: any) => { conversationUpdates.push({ id, data }); },
        list: async () => [],
      },
      notification: { show: vi.fn(async () => true) },
      fs: {
        readFile: async (path: string) => {
          if (path.endsWith('LOOP_STATE.json')) {
            return JSON.stringify({ version: 1, state: { episodeIndex: 2, acceptedCount: 1 } });
          }
          return null;
        },
        writeFile: async () => true,
        readDir: async () => [],
        createDir: async () => true,
        stat: async () => ({ size: 1, isDirectory: false, isFile: true, createdAt: '', modifiedAt: '' }),
      },
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
    conversations: [],
    activeConversationId: null,
    isStreaming: false,
    planMode: false,
    agentMode: 'standard',
    error: null,
    messageEdits: {},
    streamingRuns: {},
    queuedMessages: {},
  });
  useMemoryStore.setState({ entries: [], enabled: false, extracting: false, loaded: true });
  useCodeChangesStore.setState({ changes: [] });
}

beforeEach(() => {
  installStubs();
  resetNativeToolFallback();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetStores();
});

describe('createRsiConversation', () => {
  it('creates a persisted, independent RSI conversation and activates it', async () => {
    const id = await useChatStore.getState().createRsiConversation('p1', 'gpt-test');

    expect(id).toBe('rsi-new');
    // The record that reaches storage carries the full independent RSI state.
    expect(conversationCreates[0]).toMatchObject({
      agentMode: 'rsi',
      isChatMode: false,
      rootPath: '/proj',
    });
    expect(conversationCreates[0].rsi.status).toBe('idle');
    expect(conversationCreates[0].rsi.runs).toEqual([]);
    const state = useChatStore.getState();
    expect(state.activeConversationId).toBe('rsi-new');
    expect(state.agentMode).toBe('rsi');
    expect(state.messages).toEqual([]);
    const conv = state.conversations.find((c) => c.id === 'rsi-new');
    expect(conv?.agentMode).toBe('rsi');
    expect(conv?.rsi?.status).toBe('idle');
    expect(conv?.rsi?.directionConfig?.objective).toBe('');
    expect(conv?.rsi?.runs).toEqual([]);
    expect(conv?.isChatMode).toBe(false);
  });
});

describe('per-conversation protocol restore', () => {
  it('restores agentMode from the conversation record on switch', async () => {
    useChatStore.setState({
      conversations: [
        rsiConversation(),
        { id: 'plain-1', title: 'Plain', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 } as Conversation,
      ],
      activeConversationId: 'rsi-1',
      agentMode: 'rsi',
    });

    await useChatStore.getState().setActiveConversation('plain-1');
    expect(useChatStore.getState().agentMode).toBe('standard');

    await useChatStore.getState().setActiveConversation('rsi-1');
    expect(useChatStore.getState().agentMode).toBe('rsi');
  });

  it('mode switches stamp the active conversation but never strip a dedicated RSI one', async () => {
    useChatStore.setState({
      conversations: [rsiConversation()],
      activeConversationId: 'rsi-1',
      agentMode: 'rsi',
    });

    // Leaving the RSI view must not remove the conversation from RSI.
    useChatStore.getState().setAgentMode('standard');
    const conv = useChatStore.getState().conversations.find((c) => c.id === 'rsi-1');
    expect(conv?.agentMode).toBe('rsi');
    expect(useChatStore.getState().agentMode).toBe('standard');

    // A plain conversation records the mode it was used with.
    useChatStore.setState({
      conversations: [
        { id: 'plain-1', title: 'Plain', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 } as Conversation,
      ],
      activeConversationId: 'plain-1',
    });
    useChatStore.getState().setAgentMode('goal');
    const plain = useChatStore.getState().conversations.find((c) => c.id === 'plain-1');
    expect(plain?.agentMode).toBe('goal');
    expect(conversationUpdates.some((u) => u.id === 'plain-1' && u.data.agentMode === 'goal')).toBe(true);
  });
});

describe('entering RSI mode gets a dedicated conversation', () => {
  it('spawns a new RSI conversation instead of reusing the active chat', async () => {
    useChatStore.setState({
      conversations: [
        { id: 'plain-1', title: 'Plain', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 } as Conversation,
      ],
      activeConversationId: 'plain-1',
      agentMode: 'standard',
    });

    // Two synchronous flips — the guard must collapse them into one creation.
    useChatStore.getState().setAgentMode('rsi');
    useChatStore.getState().setAgentMode('rsi');
    await vi.waitFor(() => expect(useChatStore.getState().activeConversationId).toBe('rsi-new'));

    expect(useChatStore.getState().agentMode).toBe('rsi');
    expect(conversationCreates).toHaveLength(1);
    expect(conversationCreates[0]).toMatchObject({ agentMode: 'rsi', isChatMode: false });
    // The plain chat is untouched — no protocol stamped onto it.
    expect(useChatStore.getState().conversations.find((c) => c.id === 'plain-1')?.agentMode).toBeUndefined();
  });

  it('reopens the existing RSI conversation when one is already active', async () => {
    useChatStore.setState({
      conversations: [rsiConversation()],
      activeConversationId: 'rsi-1',
      agentMode: 'standard',
    });

    useChatStore.getState().setAgentMode('rsi');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(useChatStore.getState().activeConversationId).toBe('rsi-1');
    expect(useChatStore.getState().agentMode).toBe('rsi');
    expect(conversationCreates).toHaveLength(0);
  });

  it('automatically switches viewMode to work when entering RSI mode', async () => {
    useUIStore.setState({ viewMode: 'chat' });
    useChatStore.setState({
      conversations: [
        { id: 'plain-1', title: 'Plain', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 } as Conversation,
      ],
      activeConversationId: 'plain-1',
      agentMode: 'standard',
    });

    useChatStore.getState().setAgentMode('rsi');
    expect(useUIStore.getState().viewMode).toBe('work');

    // Also when switching to an existing RSI conversation
    useUIStore.setState({ viewMode: 'chat' });
    useChatStore.setState({
      conversations: [rsiConversation()],
    });
    await useChatStore.getState().setActiveConversation('rsi-1');
    expect(useUIStore.getState().viewMode).toBe('work');
  });
});

describe('updateRsiDirection', () => {
  it('reports failed saves and allows the next queued update to recover', async () => {
    useChatStore.setState({ conversations: [rsiConversation()], activeConversationId: 'rsi-1' });
    const update = vi.fn(async () => {});
    update.mockRejectedValueOnce(new Error('disk full'));
    (window.electronAPI.conversation.update as any) = update;
    await expect(useChatStore.getState().updateRsiDirection('rsi-1', { objective: 'Unsaved' })).rejects.toThrow('disk full');
    expect(useChatStore.getState().conversations[0].rsi?.directionConfig.objective).toBe('');
    await useChatStore.getState().updateRsiDirection('rsi-1', { objective: 'Saved' });
    expect(useChatStore.getState().conversations[0].rsi?.directionConfig.objective).toBe('Saved');
  });

  it('serializes autosaves with run updates so neither overwrites the other', async () => {
    useChatStore.setState({ conversations: [rsiConversation()], activeConversationId: 'rsi-1' });
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const update = vi.fn(async () => {});
    update.mockImplementationOnce(async () => delayed);
    (window.electronAPI.conversation.update as any) = update;
    const saving = useChatStore.getState().updateRsiDirection('rsi-1', { objective: 'Improve latency' });
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const run = beginRsiRun('rsi-1');
    const moreSaving = useChatStore.getState().updateRsiDirection('rsi-1', { scope: 'src only' });
    release();
    const [, runId] = await Promise.all([saving, run, moreSaving]);
    const rsi = useChatStore.getState().conversations[0].rsi!;
    expect(rsi.directionConfig).toMatchObject({ objective: 'Improve latency', scope: 'src only' });
    expect(rsi.runs.map((entry) => entry.id)).toEqual([runId]);
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('patches only the target conversation, on disk and in memory', async () => {
    const other = rsiConversation({ id: 'rsi-2', title: 'RSI Two' });
    useChatStore.setState({
      conversations: [rsiConversation(), other],
      activeConversationId: 'rsi-1',
    });

    await useChatStore.getState().updateRsiDirection('rsi-1', { objective: 'Halve test time' });

    const first = useChatStore.getState().conversations.find((c) => c.id === 'rsi-1');
    const second = useChatStore.getState().conversations.find((c) => c.id === 'rsi-2');
    expect(first?.rsi?.directionConfig.objective).toBe('Halve test time');
    // The other session's direction is unreachable through this path.
    expect(second?.rsi?.directionConfig.objective).toBe('');
    const update = conversationUpdates.find((u) => u.id === 'rsi-1');
    expect(update?.data.rsi.directionConfig.objective).toBe('Halve test time');
    expect(conversationUpdates.some((u) => u.id === 'rsi-2')).toBe(false);
  });
});

describe('run records on real executions', () => {
  it.each(['completed', 'stopped', 'failed'] as const)(
    'keeps a newer run running when an older %s finalization finishes its delayed read',
    async (outcome) => {
      useChatStore.setState({ conversations: [rsiConversation()], activeConversationId: 'rsi-1' });
      const oldRunId = await beginRsiRun('rsi-1');
      let release!: (value: string) => void;
      const delayedRead = new Promise<string>((resolve) => { release = resolve; });
      const read = vi.fn(async () => delayedRead);
      (window.electronAPI.fs.readFile as any) = read;

      const finishingOld = finalizeRsiRun('rsi-1', oldRunId!, outcome, 'old execution ended');
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      const newRunId = await beginRsiRun('rsi-1');
      await useChatStore.getState().updateRsiDirection('rsi-1', { objective: 'New direction' });
      release(JSON.stringify({ state: { episodeIndex: 4, acceptedCount: 1 } }));
      await finishingOld;

      const rsi = useChatStore.getState().conversations[0].rsi!;
      expect(rsi.status).toBe('running');
      expect(rsi.directionConfig.objective).toBe('New direction');
      expect(rsi.runs).toHaveLength(2);
      expect(rsi.runs[0]).toMatchObject({ id: oldRunId, status: outcome, iteration: 4 });
      expect(rsi.runs[1]).toMatchObject({ id: newRunId, status: 'running' });
      expect(conversationUpdates[conversationUpdates.length - 1].data.rsi).toEqual(rsi);
    },
  );

  it('keeps the latest completed result when a superseded run finishes later', async () => {
    useChatStore.setState({ conversations: [rsiConversation()], activeConversationId: 'rsi-1' });
    const oldRunId = await beginRsiRun('rsi-1');
    const newRunId = await beginRsiRun('rsi-1');
    await finalizeRsiRun('rsi-1', newRunId!, 'completed');
    await finalizeRsiRun('rsi-1', oldRunId!, 'failed', 'late failure');

    const rsi = useChatStore.getState().conversations[0].rsi!;
    expect(rsi.status).toBe('completed');
    expect(rsi.runs[0]).toMatchObject({ id: oldRunId, status: 'failed', result: 'late failure' });
    expect(rsi.runs[1]).toMatchObject({ id: newRunId, status: 'completed' });
    expect(conversationUpdates[conversationUpdates.length - 1].data.rsi.status).toBe('completed');
  });

  it('reads progress from the run conversation even after the user switches workspaces', async () => {
    useChatStore.setState({ conversations: [rsiConversation()], activeConversationId: 'other' });
    useWorkspaceStore.setState({ rootPath: '/different-project' });
    const read = vi.fn(async (path: string) => path.startsWith('/proj/')
      ? JSON.stringify({ state: { episodeIndex: 7, acceptedCount: 2 } }) : null);
    (window.electronAPI.fs.readFile as any) = read;
    const runId = await beginRsiRun('rsi-1');
    await finalizeRsiRun('rsi-1', runId!, 'completed');
    expect(read).toHaveBeenCalledWith('/proj/.conecode/rsi/conversations/rsi-1/LOOP_STATE.json');
    expect(useChatStore.getState().conversations[0].rsi?.runs[0].iteration).toBe(7);
  });

  it('beginRsiRun/finalizeRsiRun keep real evidence only, per conversation', async () => {
    useChatStore.setState({ conversations: [rsiConversation()], activeConversationId: 'rsi-1' });

    const runId = await beginRsiRun('rsi-1');
    expect(runId).toBeTruthy();
    let conv = useChatStore.getState().conversations.find((c) => c.id === 'rsi-1');
    expect(conv?.rsi?.status).toBe('running');
    expect(conv?.rsi?.runs).toHaveLength(1);
    expect(conv?.rsi?.runs[0].status).toBe('running');

    await finalizeRsiRun('rsi-1', runId!, 'failed', 'stream died');
    conv = useChatStore.getState().conversations.find((c) => c.id === 'rsi-1');
    expect(conv?.rsi?.status).toBe('failed');
    expect(conv?.rsi?.runs[0].status).toBe('failed');
    expect(conv?.rsi?.runs[0].result).toBe('stream died');
    // Iteration comes from the real LOOP_STATE.json (stubbed above), not a guess.
    expect(conv?.rsi?.runs[0].iteration).toBe(2);

    await finalizeRsiRun('rsi-1', runId!, 'completed');
    conv = useChatStore.getState().conversations.find((c) => c.id === 'rsi-1');
    expect(conv?.rsi?.status).toBe('completed');
    expect(conv?.rsi?.runs[0].status).toBe('completed');
    expect(conv?.rsi?.runs[0].result).toBeNull();
  });

  it('ignores conversations that are not dedicated RSI sessions', async () => {
    useChatStore.setState({
      conversations: [
        { id: 'plain-1', title: 'Plain', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 } as Conversation,
      ],
      activeConversationId: 'plain-1',
    });
    const runId = await beginRsiRun('plain-1');
    expect(runId).toBeNull();
    expect(conversationUpdates).toHaveLength(0);
  });

  it('a direction discussion injects context without registering a completed execution', async () => {
    useChatStore.setState({
      conversations: [rsiConversation()],
      activeConversationId: 'rsi-1',
      agentMode: 'rsi',
    });
    await useChatStore.getState().updateRsiDirection('rsi-1', { objective: 'Halve test time', scope: 'src/core only' });
    conversationUpdates.length = 0;

    await useChatStore.getState().sendMessage('kick off', 'p1', 'gpt-test');

    // The protocol saw this conversation's own direction and archive path.
    const systemTexts = streamCalls[0].messages
      .filter((m: any) => m.role === 'system')
      .map((m: any) => m.content);
    const direction = systemTexts.find((c: string) => c.startsWith('RSI CONVERSATION CONTEXT\n'));
    expect(direction).toContain('Conversation ID: rsi-1');
    expect(direction).toContain('Objective: Halve test time');
    expect(direction).toContain('/proj/.conecode/rsi/conversations/rsi-1');
    expect(direction).toContain('src/core only');
    // The RSI mode overlay is still present alongside the direction context.
    expect(systemTexts.some((c: string) => c.includes('recursive self-improvement') || c.includes('RSI'))).toBe(true);

    const conv = useChatStore.getState().conversations.find((c) => c.id === 'rsi-1');
    expect(conv?.rsi?.runs).toHaveLength(0);
    expect(streamCalls).toHaveLength(1);
    // The run's transcript stays in its own conversation.
    expect(transcripts['rsi-1'].some((m: any) => m.role === 'user' && m.content === 'kick off')).toBe(true);
  });
});
