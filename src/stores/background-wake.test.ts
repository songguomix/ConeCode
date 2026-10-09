import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore, resetNativeToolFallback } from './chat.store';
import { useBackgroundStore } from './background.store';
import { useModelStore } from './model.store';
import { useSettingsStore } from './settings.store';
import { useWorkspaceStore } from './workspace.store';
import { useTodosStore } from './todos.store';
import { useMemoryStore } from './memory.store';
import { useCodeChangesStore } from './codeChanges.store';
import { BUILTIN_TOOLS, PLAN_MODE_TOOLS, validateToolArgs } from '../core/tools/definitions';
import type { AIModel } from '../types';

// Full delegation loop: parent delegates via run_background, the child runs
// detached, completion wakes the parent with the child's result.

let streamCalls: any[];
let queued: any[];
let created: any[];
let transcripts: Record<string, any[]>;
let childSeq: number;

const model: AIModel = {
  id: 'gpt-test', name: 'GPT Test', providerId: 'p1',
  supportsText: true, supportsVision: false, supportsImageGeneration: false,
  supportsAudioInput: false, supportsAudioOutput: false,
  supportsFunctionCalling: true, supportsReasoning: false,
  contextWindow: 128000, maxOutputTokens: 8192, enabled: true,
};

function toolCallResponse(name: string, args: Record<string, any>, id = 'call_1') {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: 'tool_calls',
    }],
  };
}

const textResponse = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

function installStubs() {
  streamCalls = [];
  queued = [];
  created = [];
  transcripts = {};
  childSeq = 0;

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
        create: async (d: any) => {
          childSeq += 1;
          return { id: `child${childSeq}`, title: 'New Chat', ...d, createdAt: 0, updatedAt: 0 };
        },
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
  });
  useMemoryStore.setState({ entries: [], enabled: false, extracting: false, loaded: true });
  useCodeChangesStore.setState({ changes: [] });
  useBackgroundStore.setState({ tasks: {} });
}

describe('agent background delegation', () => {
  beforeEach(() => {
    installStubs();
    resetNativeToolFallback();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    resetStores();
  });

  it('delegates a download, then wakes the parent with the result', async () => {
    queued = [
      toolCallResponse('run_background', { task: 'download the dataset to /tmp/data' }),
      textResponse('downloaded 42MB to /tmp/data'),
      textResponse('parent continued with the file'),
    ];
    await useChatStore.getState().sendMessage('fetch the dataset', 'p1', 'gpt-test');
    // Child runs detached — wait for it to settle, then reconcile.
    await vi.waitFor(() => expect(useChatStore.getState().streamingRuns).toEqual({}));
    useBackgroundStore.getState().sync();
    await vi.waitFor(() => expect(streamCalls).toHaveLength(3));

    // Parent → child → parent again, each in its own conversation.
    expect(streamCalls.map((c) => c.conversationId)).toEqual(['conv1', 'child1', 'conv1']);
    // The wake message carries the child's outcome into the parent.
    const wake = created.find((m) => m.conversationId === 'conv1' && String(m.content).includes('downloaded 42MB'));
    expect(wake).toBeDefined();
    expect(wake.content).toContain('[background task');
    // …and the resumed parent turn actually reasons over it.
    expect(JSON.stringify(streamCalls[2].messages)).toContain('downloaded 42MB');
    const task = useBackgroundStore.getState().tasks.child1;
    expect(task.status).toBe('done');
    expect(task.parentConversationId).toBe('conv1');
  });

  it('appends to a live parent run instead of starting a second one', async () => {
    useChatStore.setState({
      messages: [{ id: 'u', conversationId: 'conv1', role: 'user', content: 'hi', createdAt: 1 }],
      streamingRuns: { conv1: { content: '', reasoningContent: '', status: 'thinking', toolName: null } } as any,
    });
    await useChatStore.getState().resumeAfterBackground('conv1', 'dl', 'file is ready');
    expect(streamCalls).toHaveLength(0);
    const live = useChatStore.getState().messages;
    expect(live[live.length - 1].content).toContain('file is ready');
    expect(created.some((m) => String(m.content).includes('file is ready'))).toBe(true);
  });

  it('tells the parent when the child stalls on approval', async () => {
    useCodeChangesStore.setState({
      changes: [{
        id: 'c1', kind: 'edit', filePath: '/proj/a.ts', originalCode: 'o', newCode: 'n',
        description: '', status: 'pending', createdAt: 1, conversationId: 'child9', messageId: 'm',
      }] as any,
    });
    useBackgroundStore.getState().register('child9', 'stalled job', 'agent', 'conv1');
    useChatStore.setState({ streamingRuns: { child9: { content: '', reasoningContent: '', status: 'thinking', toolName: null } } as any });
    useBackgroundStore.getState().sync();
    useChatStore.setState({ streamingRuns: {} });
    useBackgroundStore.getState().sync();
    await vi.waitFor(() => expect(created.some((m) => String(m.content).includes('approval'))).toBe(true));
  });

  it('registers both tools, withholds delegation in plan mode', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('run_background');
    expect(names).toContain('background_status');
    expect(PLAN_MODE_TOOLS.has('run_background')).toBe(false);
    expect(PLAN_MODE_TOOLS.has('background_status')).toBe(true);
    expect(validateToolArgs('run_background', { task: 'x' })).toBeNull();
    expect(validateToolArgs('run_background', {})).toContain('task');
  });
});
