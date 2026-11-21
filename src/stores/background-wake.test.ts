import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNativeToolFallback, retryTiming, useChatStore } from './chat.store';
import { backgroundRetryTiming, useBackgroundStore } from './background.store';
import { useModelStore } from './model.store';
import { useSettingsStore } from './settings.store';
import { useWorkspaceStore } from './workspace.store';
import { useTodosStore } from './todos.store';
import { useMemoryStore } from './memory.store';
import { useCodeChangesStore } from './codeChanges.store';
import { useUIStore } from './ui.store';
import { BUILTIN_TOOLS, PLAN_MODE_TOOLS, validateToolArgs } from '../core/tools/definitions';
import type { AIModel, Conversation, Message } from '../types';

// Full delegation loop: parent delegates via run_background, the child runs
// detached, completion wakes the parent with the child's result.

let streamCalls: any[];
let queued: any[];
let created: Message[];
let transcripts: Record<string, Message[]>;
let conversations: Map<string, Conversation>;
let childSeq: number;
let stopBackground: () => void;

const parent: Conversation = {
  id: 'conv1', title: 'One', providerId: 'p1', modelId: 'gpt-test', rootPath: '/proj', createdAt: 0, updatedAt: 0,
};

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

function lastMessage(id: string): Message | undefined {
  const messages = transcripts[id];
  return messages?.[messages.length - 1];
}

function installStubs() {
  streamCalls = [];
  queued = [];
  created = [];
  transcripts = {};
  conversations = new Map([[parent.id, structuredClone(parent)]]);
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
        create: async (m: Message) => {
          created.push(m);
          (transcripts[m.conversationId] ||= []).push(structuredClone(m));
          return m;
        },
        list: async (id: string) => structuredClone(transcripts[id] || []),
        delete: async () => true,
      },
      conversation: {
        create: async (data: Partial<Conversation>) => {
          childSeq += 1;
          const conversation = { id: `child${childSeq}`, title: 'New Chat', providerId: '', modelId: '', ...data, createdAt: 0, updatedAt: 0 };
          conversations.set(conversation.id, structuredClone(conversation));
          return conversation;
        },
        update: async (id: string, patch: Partial<Conversation>) => {
          const existing = conversations.get(id);
          if (existing) conversations.set(id, structuredClone({ ...existing, ...patch }));
        },
        list: async () => structuredClone([...conversations.values()]),
      },
      exec: { run: vi.fn(async () => ({ success: true, stdout: 'approved output', stderr: '', exitCode: 0 })) },
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
  useUIStore.setState({ viewMode: 'work' });
  useWorkspaceStore.setState({ rootPath: '/proj', mcpTools: [], contextFiles: [], selectedFile: null, fileContent: null, agentsMd: null });
  useTodosStore.getState().clearTodos();
  useChatStore.setState({
    messages: [],
    conversations: [parent],
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

async function restartRenderer() {
  stopBackground();
  useCodeChangesStore.setState({ changes: [] });
  useBackgroundStore.setState({ tasks: {} });
  useChatStore.setState({ conversations: [], activeConversationId: null, messages: [], streamingRuns: {}, isStreaming: false });
  const ready = useChatStore.getState().fetchConversations();
  stopBackground = useBackgroundStore.getState().init(ready);
  await ready;
}

beforeEach(() => {
  installStubs();
  resetNativeToolFallback();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetStores();
  stopBackground = useBackgroundStore.getState().init();
});

afterEach(() => {
  stopBackground();
  vi.restoreAllMocks();
});

describe('agent background delegation', () => {

  it('delegates a download, then wakes the parent with the result', async () => {
    queued = [
      toolCallResponse('run_background', { task: 'download the dataset to /tmp/data' }),
      textResponse('downloaded 42MB to /tmp/data'),
      textResponse('parent continued with the file'),
    ];
    await useChatStore.getState().sendMessage('fetch the dataset', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(3));
    await vi.waitFor(() => expect(useChatStore.getState().streamingRuns).toEqual({}));

    // Parent → child → parent again, each in its own conversation.
    expect(streamCalls.map((c) => c.conversationId)).toEqual(['conv1', 'child1', 'conv1']);
    // The wake message carries the child's outcome into the parent.
    const wake = created.find((m) => m.conversationId === 'conv1' && String(m.content).includes('downloaded 42MB'));
    expect(wake?.content).toContain('[background task');
    // …and the resumed parent turn actually reasons over it.
    expect(JSON.stringify(streamCalls[2].messages)).toContain('downloaded 42MB');
    const task = useBackgroundStore.getState().tasks.child1;
    expect(task.status).toBe('done');
    expect(task.parentConversationId).toBe('conv1');

    // The report reached the parent before the renderer stopped, but its
    // delivery marker did not. Reconciliation must not write it a second time.
    await vi.waitFor(() => expect(conversations.get('child1')?.backgroundTask?.reported).toBe(true));
    const child = conversations.get('child1')!;
    conversations.set('child1', { ...child, backgroundTask: { ...child.backgroundTask!, reported: false } });
    await restartRenderer();
    await vi.waitFor(() => expect(conversations.get('child1')?.backgroundTask?.reported).toBe(true));
    expect(transcripts.conv1.filter((message) => message.id === wake?.id)).toHaveLength(1);
    expect(streamCalls.map((call) => call.conversationId)).toEqual(['conv1', 'child1', 'conv1']);
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
    queued = [
      toolCallResponse('run_background', { task: 'run the formatter' }),
      toolCallResponse('exec', { command: 'npm run format' }),
      textResponse('parent relayed the approval request'),
    ];
    await useChatStore.getState().sendMessage('delegate formatting', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(created.some((message) =>
      message.conversationId === 'conv1' && message.content.includes('waiting for the user to review an action'),
    )).toBe(true));
    await vi.waitFor(() => expect(useChatStore.getState().streamingRuns).toEqual({}));
    expect(conversations.get('child1')?.backgroundTask?.status).toBe('waiting');
    expect(window.electronAPI.exec.run).not.toHaveBeenCalled();

    const approval = useCodeChangesStore.getState().changes.find((change) => change.conversationId === 'child1');
    expect(approval?.status).toBe('pending');
    queued = [textResponse('child finished after approval'), textResponse('parent received the final result')];
    await useCodeChangesStore.getState().applyChange(approval!.id);
    await vi.waitFor(() => expect(useChatStore.getState().streamingRuns).toEqual({}));
    await vi.waitFor(() => expect(lastMessage('conv1')?.content).toBe('parent received the final result'));
    expect(conversations.get('child1')?.backgroundTask?.status).toBe('done');
    expect(transcripts.child1).toContainEqual(expect.objectContaining({ backgroundApprovalResult: true }));
    expect(window.electronAPI.exec.run).toHaveBeenCalledTimes(1);
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

describe('background task recovery', () => {
  it('retries temporary outages after the normal stream retries are exhausted', async () => {
    const oldStreamDelay = retryTiming.baseMs;
    const oldBackgroundDelay = backgroundRetryTiming.baseMs;
    retryTiming.baseMs = 1;
    backgroundRetryTiming.baseMs = 1;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      if (streamCalls.length <= 9) throw new Error('network unreachable');
      return textResponse('recovered reply');
    });

    try {
      expect(await useBackgroundStore.getState().launch('draft the release summary')).toBe('child1');
      await vi.waitFor(() => expect(conversations.get('child1')?.backgroundTask?.status).toBe('done'));
      expect(streamCalls.length).toBeGreaterThan(9);
      expect(streamCalls.every((call) => call.conversationId === 'child1')).toBe(true);
      expect(transcripts.child1.filter((message) => message.content === 'draft the release summary')).toHaveLength(1);
      expect(lastMessage('child1')?.content).toBe('recovered reply');
      expect(window.electronAPI.notification.show).toHaveBeenCalledTimes(1);
      expect(useChatStore.getState().activeConversationId).toBe('conv1');
    } finally {
      retryTiming.baseMs = oldStreamDelay;
      backgroundRetryTiming.baseMs = oldBackgroundDelay;
    }
  });

  it('resumes the same conversation from the saved transcript after restarting', async () => {
    const id = 'saved';
    conversations.set(id, {
      ...parent, id, title: 'Saved background job',
      backgroundTask: { status: 'running', source: 'chat', startedAt: 1, finishedAt: null, unseen: false, promptId: 'user' },
    });
    transcripts[id] = [
      { id: 'user', conversationId: id, role: 'user', content: 'summarize notes.txt', createdAt: 1 },
      { id: 'tool-call', conversationId: id, role: 'assistant', content: '', createdAt: 2,
        toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: '/proj/notes.txt' } }] },
      { id: 'tool-result', conversationId: id, role: 'tool', content: 'We shipped the first milestone.', createdAt: 3,
        toolCallId: 'read-1', toolName: 'read_file' },
    ];
    const readFile = vi.spyOn(window.electronAPI.fs, 'readFile');
    queued = [textResponse('The first milestone shipped.')];

    await restartRenderer();
    await vi.waitFor(() => expect(conversations.get(id)?.backgroundTask?.status).toBe('done'));

    expect(streamCalls.map((call) => call.conversationId)).toEqual([id]);
    expect(JSON.stringify(streamCalls[0].messages)).toContain('We shipped the first milestone.');
    expect(readFile).not.toHaveBeenCalledWith('/proj/notes.txt');
    expect(transcripts[id].filter((message) => message.role === 'user' && !message.isToolResult)).toEqual([
      expect.objectContaining({ id: 'user', content: 'summarize notes.txt' }),
    ]);
    expect(childSeq).toBe(0);
  });

  it.each([false, true])('recovers a task stranded during launch with its prompt already written: %s', async (promptWritten) => {
    const id = 'launching';
    const prompt = { id: 'saved-prompt', conversationId: id, role: 'user' as const, content: 'draft a changelog', createdAt: 1 };
    conversations.set(id, {
      ...parent, id, title: 'Changelog',
      backgroundTask: {
        status: 'running', source: 'chat', startedAt: 1, finishedAt: null, unseen: false,
        promptId: prompt.id, initialPrompt: prompt.content,
      },
    });
    if (promptWritten) transcripts[id] = [prompt];
    queued = [textResponse('The changelog is ready.')];

    await restartRenderer();
    await vi.waitFor(() => expect(conversations.get(id)?.backgroundTask?.status).toBe('done'));
    expect(streamCalls.map((call) => call.conversationId)).toEqual([id]);
    expect(transcripts[id].filter((message) => message.role === 'user')).toEqual([
      expect.objectContaining({ id: prompt.id, content: prompt.content }),
    ]);
    expect(created.filter((message) => message.id === prompt.id)).toHaveLength(promptWritten ? 0 : 1);
  });

  it('keeps a completed answer after a restart interrupted the final status update', async () => {
    const id = 'answered';
    conversations.set(id, {
      ...parent, id, title: 'Answered task',
      backgroundTask: { status: 'running', source: 'chat', startedAt: 1, finishedAt: null, unseen: false, promptId: 'prompt' },
    });
    transcripts[id] = [
      { id: 'prompt', conversationId: id, role: 'user', content: 'draft the changelog', createdAt: 1 },
      { id: 'final', conversationId: id, role: 'assistant', content: 'The changelog is ready.', createdAt: 2, backgroundFinal: true },
    ];

    await restartRenderer();
    await vi.waitFor(() => expect(conversations.get(id)?.backgroundTask?.status).toBe('done'));
    expect(streamCalls).toHaveLength(0);
    expect(transcripts[id]).toHaveLength(2);
    expect(window.electronAPI.notification.show).toHaveBeenCalledTimes(1);
  });

  it('keeps a question waiting after restarting until the user answers', async () => {
    queued = [toolCallResponse('ask_user', { question: 'Which title should I use?' })];
    await useBackgroundStore.getState().launch('write the summary');
    await vi.waitFor(() => expect(conversations.get('child1')?.backgroundTask?.status).toBe('waiting'));
    await vi.waitFor(() => expect(useChatStore.getState().streamingRuns).toEqual({}));

    await restartRenderer();
    await vi.waitFor(() => expect(useBackgroundStore.getState().tasks.child1?.status).toBe('waiting'));
    expect(streamCalls).toHaveLength(1);
    expect(lastMessage('child1')).toMatchObject({ isQuestion: true, content: 'Which title should I use?' });

    await useChatStore.getState().setActiveConversation('child1');
    queued = [textResponse('Summary with the chosen title')];
    await useChatStore.getState().sendMessage('Use November update', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(conversations.get('child1')?.backgroundTask?.status).toBe('done'));
    expect(streamCalls.map((call) => call.conversationId)).toEqual(['child1', 'child1']);
    expect(lastMessage('child1')?.content).toBe('Summary with the chosen title');
  });

  it('resumes when an approval result was saved before the renderer stopped', async () => {
    queued = [toolCallResponse('exec', { command: 'npm run format' })];
    await useBackgroundStore.getState().launch('format the project');
    await vi.waitFor(() => expect(conversations.get('child1')?.backgroundTask?.status).toBe('waiting'));
    await vi.waitFor(() => expect(useChatStore.getState().streamingRuns).toEqual({}));
    expect(lastMessage('child1')?.backgroundWait).toBe('approval');

    const outcome = 'User approved command `npm run format`.\nCommand output:\nAll files already formatted.';
    transcripts.child1.push({
      id: 'approval-result', conversationId: 'child1', role: 'user', content: outcome,
      createdAt: Date.now(), isToolResult: true, backgroundApprovalResult: true,
    });
    queued = [textResponse('Formatting finished.')];

    await restartRenderer();
    await vi.waitFor(() => expect(conversations.get('child1')?.backgroundTask?.status).toBe('done'));
    expect(streamCalls.map((call) => call.conversationId)).toEqual(['child1', 'child1']);
    expect(JSON.stringify(streamCalls[1].messages)).toContain('All files already formatted.');
    expect(window.electronAPI.exec.run).not.toHaveBeenCalled();
    expect(lastMessage('child1')?.content).toBe('Formatting finished.');
  });

  it('does not restart a task the user stopped while a retry was pending', async () => {
    const oldStreamDelay = retryTiming.baseMs;
    retryTiming.baseMs = 500;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      throw new Error('network unreachable');
    });

    try {
      await useBackgroundStore.getState().launch('draft the release summary');
      await vi.waitFor(() => expect(useChatStore.getState().streamingRuns.child1?.retry).toBeTruthy());
      useChatStore.getState().stopGeneration('child1');
      await vi.waitFor(() => expect(conversations.get('child1')?.backgroundTask?.status).toBe('stopped'));

      await restartRenderer();
      await vi.waitFor(() => expect(useBackgroundStore.getState().tasks.child1?.status).toBe('stopped'));
      expect(streamCalls).toHaveLength(1);
      expect(window.electronAPI.notification.show).not.toHaveBeenCalled();
    } finally {
      retryTiming.baseMs = oldStreamDelay;
    }
  });
});
