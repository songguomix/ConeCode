import { useGithubPushStore } from './githubPush.store';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from './chat.store';
import { useModelStore } from './model.store';
import { useLanguageStore } from './language.store';
import { useSettingsStore } from './settings.store';
import { useWorkspaceStore } from './workspace.store';
import { useTodosStore } from './todos.store';
import { useMemoryStore } from './memory.store';
import { resetNativeToolFallback } from './chat.store';
import { useCodeChangesStore } from './codeChanges.store';
import type { AIModel, Message } from '../types';

// End-to-end exercise of runAgentLoop against a fake provider, which is the only
// way to catch breakage BETWEEN the pieces the unit tests cover individually.

let streamCalls: any[];
let queued: any[];
let created: any[];
let files: Map<string, string>;

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
  files = new Map([['/proj/a.ts', 'file body']]);

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
        create: async (m: any) => { created.push(m); return m; },
        editAndTruncate: vi.fn(async (conversationId: string, _messageId: string, content: string) => ({
          id: 'edited', conversationId, role: 'user', content, createdAt: Date.now(),
        })),
        delete: async () => true,
        list: async () => [],
      },
      conversation: {
        create: async (d: any) => ({ id: 'conv1', title: 'New Chat', ...d, createdAt: 0, updatedAt: 0 }),
        update: async () => {},
        list: async () => [],
      },
      fs: {
        readFile: async (p: string) => files.get(p) ?? null,
        writeFile: async (p: string, c: string) => { files.set(p, c); return true; },
        readDir: async () => [{ name: 'a.ts', path: '/proj/a.ts', isDirectory: false }],
        exists: async (p: string) => files.has(p),
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

describe('runAgentLoop with native tool calling', () => {
  beforeEach(() => {
    installStubs();
    resetNativeToolFallback();
    vi.spyOn(console, 'log').mockImplementation(() => {});
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
    // Memory extraction fires its own provider call after each turn; switch it
    // off here so these assertions describe the agent loop alone (it has its
    // own tests in memoryIntegration.test.ts).
    useMemoryStore.setState({ entries: [], enabled: false, extracting: false, loaded: true });
    useCodeChangesStore.setState({ changes: [] });
  });

  const editHistory = (): Message[] => [
    { id: 'before', conversationId: 'conv1', role: 'user', content: 'keep this context', createdAt: 1 },
    { id: 'target', conversationId: 'conv1', role: 'user', content: 'old prompt', createdAt: 2 },
    { id: 'answer', conversationId: 'conv1', role: 'assistant', content: 'obsolete answer', createdAt: 3 },
    { id: 'later', conversationId: 'conv1', role: 'user', content: 'obsolete followup', createdAt: 4 },
  ];

  it('edits a past prompt and regenerates with only the preceding context', async () => {
    useChatStore.setState({ messages: editHistory() });
    const pending = {
      id: 'pending', kind: 'edit' as const, filePath: '/proj/a.ts', originalCode: 'old', newCode: 'new',
      description: '', status: 'pending' as const, createdAt: 1, conversationId: 'conv1', messageId: 'answer',
    };
    useCodeChangesStore.setState({ changes: [pending, { ...pending, id: 'applied', status: 'applied' }] });
    await useChatStore.getState().editMessage('target', 'corrected prompt', 'p1', 'gpt-test');

    expect(window.electronAPI.message.editAndTruncate).toHaveBeenCalledWith('conv1', 'target', 'corrected prompt');
    expect(streamCalls).toHaveLength(1);
    const context = JSON.stringify(streamCalls[0].messages);
    expect(context).toContain('keep this context');
    expect(context).toContain('corrected prompt');
    for (const removed of ['old prompt', 'obsolete answer', 'obsolete followup']) expect(context).not.toContain(removed);
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['keep this context', 'corrected prompt', 'done']);
    expect(useCodeChangesStore.getState().changes.map((c) => c.id)).toEqual(['applied']);
    expect(files.get('/proj/a.ts')).toBe('file body');
  });

  it('keeps the original transcript and reports a failed edit save', async () => {
    const history = editHistory();
    useChatStore.setState({ messages: history });
    window.electronAPI.message.editAndTruncate = vi.fn(async () => { throw new Error('disk full'); });
    await useChatStore.getState().editMessage('target', 'corrected', 'p1', 'gpt-test');
    expect(useChatStore.getState().messages).toEqual(history);
    expect(useChatStore.getState().error).toContain('disk full');
    expect(useChatStore.getState().messageEdits).toEqual({});
    expect(streamCalls).toHaveLength(0);
  });

  it('discards the old streaming reply when an edit starts a replacement run', async () => {
    let finishOldRun!: (value: any) => void;
    window.electronAPI.chat.stop = vi.fn(async () => true);
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      if (streamCalls.length === 1) return new Promise((resolve) => { finishOldRun = resolve; });
      return textResponse('replacement answer');
    });
    const oldRun = useChatStore.getState().sendMessage('original prompt', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(finishOldRun).toBeDefined());
    const target = useChatStore.getState().messages[0];
    await useChatStore.getState().editMessage(target.id, 'corrected prompt', 'p1', 'gpt-test');
    finishOldRun(textResponse('stale late reply'));
    await oldRun;
    expect(window.electronAPI.chat.stop).toHaveBeenCalledWith('conv1');
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['corrected prompt', 'replacement answer']);
    expect(created.some((m) => m.content === 'stale late reply')).toBe(false);
  });

  it('does not overwrite or send into a different chat if the user switches while saving', async () => {
    useChatStore.setState({ messages: editHistory() });
    let finishSave!: (message: Message) => void;
    window.electronAPI.message.editAndTruncate = vi.fn(() => new Promise<Message>((resolve) => { finishSave = resolve; }));
    const editing = useChatStore.getState().editMessage('target', 'corrected', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(finishSave).toBeDefined());
    const other: Message[] = [{ id: 'other', conversationId: 'conv2', role: 'user', content: 'other chat', createdAt: 5 }];
    useChatStore.setState({ activeConversationId: 'conv2', messages: other });
    finishSave({ id: 'edited', conversationId: 'conv1', role: 'user', content: 'corrected', createdAt: 6 });
    await editing;
    expect(useChatStore.getState().messages).toEqual(other);
    expect(streamCalls).toHaveLength(0);
  });

  it('rejects invalid edits and duplicate submissions without changing history', async () => {
    useChatStore.setState({ messages: editHistory() });
    for (const [id, content] of [['missing', 'x'], ['answer', 'x'], ['target', '   ']]) {
      await useChatStore.getState().editMessage(id, content, 'p1', 'gpt-test');
    }
    expect(window.electronAPI.message.editAndTruncate).not.toHaveBeenCalled();
    let finishSave!: (message: Message) => void;
    window.electronAPI.message.editAndTruncate = vi.fn(() => new Promise<Message>((resolve) => { finishSave = resolve; }));
    const first = useChatStore.getState().editMessage('target', 'corrected', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(finishSave).toBeDefined());
    await useChatStore.getState().editMessage('target', 'duplicate', 'p1', 'gpt-test');
    await useChatStore.getState().sendMessage('accidental append', 'p1', 'gpt-test');
    finishSave({ id: 'edited', conversationId: 'conv1', role: 'user', content: 'corrected', createdAt: 6 });
    await first;
    expect(window.electronAPI.message.editAndTruncate).toHaveBeenCalledTimes(1);
    expect(streamCalls).toHaveLength(1);
    expect(created.some((m) => m.content === 'accidental append')).toBe(false);
  });

  it('sends the tool schemas to the provider', async () => {
    queued = [textResponse('hello')];
    await useChatStore.getState().sendMessage('hi', 'p1', 'gpt-test');

    expect(streamCalls).toHaveLength(1);
    const tools = streamCalls[0].tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.map((t: any) => t.name)).toContain('read_file');
    expect(streamCalls[0].toolChoice).toBe('auto');
  });

  it('executes a returned tool call and feeds the result back', async () => {
    queued = [
      toolCallResponse('read_file', { path: '/proj/a.ts' }),
      textResponse('The file says "file body".'),
    ];

    await useChatStore.getState().sendMessage('read a.ts', 'p1', 'gpt-test');

    const messages = useChatStore.getState().messages;
    const assistant = messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(assistant, 'assistant turn should carry the tool call').toBeDefined();
    expect(assistant!.toolCalls![0].name).toBe('read_file');

    const toolResult = messages.find((m) => m.role === 'tool');
    expect(toolResult, 'a tool result message should be recorded').toBeDefined();
    expect(toolResult!.toolCallId).toBe('call_1');
    expect(toolResult!.content).toContain('file body');

    // The loop must continue after the tool result — two provider turns total.
    expect(streamCalls).toHaveLength(2);
    // ...and the second request must replay the call/result pair in protocol form.
    const replayed = streamCalls[1].messages;
    expect(replayed.some((m: any) => m.role === 'assistant' && m.tool_calls?.length)).toBe(true);
    expect(replayed.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_1')).toBe(true);
  });

  it('continues after create_dir instead of treating the task as finished', async () => {
    queued = [
      toolCallResponse('create_dir', { path: '/proj/new-dir' }),
      textResponse('Directory created and the task is complete.'),
    ];

    await useChatStore.getState().sendMessage('create the directory', 'p1', 'gpt-test');

    expect(streamCalls).toHaveLength(2);
    expect(created.some((message) => message.content === 'Directory created and the task is complete.')).toBe(true);
  });

  it('retries a transient stream failure and keeps the task running', async () => {
    let attempts = 0;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      attempts++;
      if (attempts === 1) throw new Error('Stream idle timeout after 120000ms');
      return textResponse('completed after retry');
    });

    await useChatStore.getState().sendMessage('keep going', 'p1', 'gpt-test');

    expect(streamCalls).toHaveLength(2);
    expect(created.some((message) => message.content === 'completed after retry')).toBe(true);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('runs several parallel tool calls and answers every call id', async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    window.electronAPI.fs.readFile = async (path: string) => {
      activeReads++;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeReads--;
      return files.get(path) ?? 'other body';
    };
    queued = [
      {
        choices: [{
          message: {
            role: 'assistant', content: '',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/proj/a.ts"}' } },
              { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"/proj/b.ts"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      },
      textResponse('done'),
    ];

    await useChatStore.getState().sendMessage('look around', 'p1', 'gpt-test');

    const toolMsgs = useChatStore.getState().messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.toolCallId).sort()).toEqual(['c1', 'c2']);
    expect(maxActiveReads).toBe(2);
  });

  it('returns one tool failure to the model without aborting the loop', async () => {
    window.electronAPI.fs.readFile = async () => { throw new Error('disk unavailable'); };
    queued = [toolCallResponse('read_file', { path: '/proj/a.ts' }), textResponse('I handled the failure.')];

    await useChatStore.getState().sendMessage('read it', 'p1', 'gpt-test');

    const toolResult = useChatStore.getState().messages.find((m) => m.role === 'tool');
    expect(toolResult!.content).toContain('disk unavailable');
    expect(streamCalls).toHaveLength(2);
    expect(useChatStore.getState().error).toBeNull();
  });

  it('reports a malformed call back to the model instead of stalling', async () => {
    queued = [
      toolCallResponse('read_file', {}), // missing the required path
      textResponse('sorry, retrying'),
    ];

    await useChatStore.getState().sendMessage('read something', 'p1', 'gpt-test');

    const toolResult = useChatStore.getState().messages.find((m) => m.role === 'tool');
    expect(toolResult!.content).toContain('path');
    expect(streamCalls).toHaveLength(2); // the loop kept going
  });

  it('falls back to prompt mode when the provider rejects tools', async () => {
    let first = true;
    (globalThis as any).window.electronAPI.chat.stream = async (params: any) => {
      streamCalls.push(params);
      if (first) {
        first = false;
        throw new Error('API error 400: tools is not supported for this model');
      }
      return textResponse('answered without tools');
    };

    await useChatStore.getState().sendMessage('hi', 'p1', 'gpt-test');

    expect(streamCalls).toHaveLength(2);
    expect(streamCalls[0].tools).toBeDefined();
    expect(streamCalls[1].tools, 'retry must drop the tools field').toBeUndefined();
    expect(useChatStore.getState().error).toBeNull();
  });

  it('uses the prompt protocol when the setting says so', async () => {
    useSettingsStore.setState({ toolCallMode: 'prompt' });
    queued = [textResponse('```json\n{"action":"read_file","path":"/proj/a.ts"}\n```'), textResponse('done')];

    await useChatStore.getState().sendMessage('read it', 'p1', 'gpt-test');

    expect(streamCalls[0].tools).toBeUndefined();
    // The json action still executes, and its result comes back as a user turn.
    const toolResult = useChatStore.getState().messages.find((m) => m.isToolResult);
    expect(toolResult!.role).toBe('user');
    expect(toolResult!.content).toContain('file body');
  });

  it('reports a malformed prompt-mode call and lets the model retry', async () => {
    useSettingsStore.setState({ toolCallMode: 'prompt' });
    queued = [textResponse('```json\n{"action":"read_file"}\n```'), textResponse('fixed')];

    await useChatStore.getState().sendMessage('read it', 'p1', 'gpt-test');

    const toolResult = useChatStore.getState().messages.find((m) => m.isToolResult);
    expect(toolResult!.content).toContain('path');
    expect(streamCalls).toHaveLength(2);
  });

  it('withholds mutating tools in Plan Mode', async () => {
    useChatStore.setState({ planMode: true });
    queued = [textResponse('here is the plan')];

    await useChatStore.getState().sendMessage('plan it', 'p1', 'gpt-test');

    const names = streamCalls[0].tools.map((t: any) => t.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('exec');
  });

  it('blocks a prompt-mode action outside the Plan Mode allowlist', async () => {
    let opened = false;
    (window.electronAPI.app as any).open = async () => { opened = true; return true; };
    useSettingsStore.setState({ toolCallMode: 'prompt' });
    useChatStore.setState({ planMode: true });
    queued = [textResponse('```json\n{"action":"open_app","name":"Safari"}\n```'), textResponse('I will present a plan.')];

    await useChatStore.getState().sendMessage('plan it', 'p1', 'gpt-test');

    expect(opened).toBe(false);
    expect(useChatStore.getState().messages.find((m) => m.isToolResult)?.content).toContain('Plan Mode');
    expect(streamCalls).toHaveLength(2);
  });

  it('writes native ask_user results before the visible question and skips later side effects', async () => {
    let opened = false;
    (window.electronAPI.app as any).open = async () => { opened = true; return true; };
    queued = [{
      choices: [{
        message: {
          role: 'assistant', content: '', tool_calls: [
            { id: 'ask', type: 'function', function: { name: 'ask_user', arguments: '{"question":"Which option?"}' } },
            { id: 'open', type: 'function', function: { name: 'open_app', arguments: '{"name":"Safari"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    }];

    await useChatStore.getState().sendMessage('do it', 'p1', 'gpt-test');

    const messages = useChatStore.getState().messages;
    const toolIndexes = messages
      .map((message, index) => message.role === 'tool' ? index : -1)
      .filter((index) => index >= 0);
    const questionIndex = messages.findIndex((message) => message.isQuestion);
    expect(toolIndexes).toHaveLength(2);
    expect(Math.max(...toolIndexes)).toBeLessThan(questionIndex);
    expect(messages.find((message) => message.toolCallId === 'open')?.content).toContain('Skipped');
    expect(opened).toBe(false);
    expect(streamCalls).toHaveLength(1);
  });

  it('does not append an old response after switching conversations mid-stream', async () => {
    let release!: (value: any) => void;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      return new Promise((resolve) => { release = resolve; });
    });
    window.electronAPI.chat.stop = vi.fn(async () => true);
    const conv2Message = {
      id: 'conv2-existing', conversationId: 'conv2', role: 'user' as const,
      content: 'second chat', createdAt: 1,
    };
    window.electronAPI.message.list = vi.fn(async () => [conv2Message]);
    useChatStore.setState({
      conversations: [
        { id: 'conv1', title: 'One', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 },
        { id: 'conv2', title: 'Two', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 },
      ],
    });

    const sending = useChatStore.getState().sendMessage('slow answer', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(1));
    await useChatStore.getState().setActiveConversation('conv2');
    release(textResponse('belongs to chat one'));
    await sending;

    const state = useChatStore.getState();
    expect(window.electronAPI.chat.stop).not.toHaveBeenCalled();
    expect(state.activeConversationId).toBe('conv2');
    expect(state.messages).toEqual([conv2Message]);
    expect(created.some((message) => message.conversationId === 'conv1' && message.role === 'assistant' && message.content === 'belongs to chat one')).toBe(true);
  });

  it('continues with the main answer after automatic compaction succeeds', async () => {
    useModelStore.setState({ models: new Map([['p1', [{ ...model, contextWindow: 100 }]]]) });
    useChatStore.setState({
      messages: Array.from({ length: 13 }, (_, index) => ({
        id: `old-${index}`, conversationId: 'conv1', role: 'user' as const,
        content: 'x'.repeat(120), createdAt: index,
      })),
    });
    queued = [textResponse('compact summary'), textResponse('main answer')];

    await useChatStore.getState().sendMessage('trigger compaction', 'p1', 'gpt-test');

    expect(streamCalls).toHaveLength(2);
    expect(streamCalls[0].messages[0].content).toContain('compress');
    expect(created.some((message) => message.isSummary)).toBe(true);
    expect(created.some((message) => message.content === 'main answer')).toBe(true);
  });

  it('does not start the main answer after the user stops automatic compaction', async () => {
    let release!: (value: any) => void;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      return new Promise((resolve) => { release = resolve; });
    });
    useModelStore.setState({ models: new Map([['p1', [{ ...model, contextWindow: 100 }]]]) });
    useChatStore.setState({
      messages: Array.from({ length: 13 }, (_, index) => ({
        id: `old-${index}`, conversationId: 'conv1', role: 'user' as const,
        content: 'x'.repeat(120), createdAt: index,
      })),
    });

    const sending = useChatStore.getState().sendMessage('trigger compaction', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(1));
    useChatStore.getState().stopGeneration();
    release(textResponse('summary that should be discarded'));
    await sending;

    expect(streamCalls).toHaveLength(1);
    expect(created.some((message) => message.isSummary)).toBe(false);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('continues the main answer when automatic compaction fails', async () => {
    let first = true;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      if (first) {
        first = false;
        throw new Error('compaction unavailable');
      }
      return textResponse('main answer after compaction failure');
    });
    useModelStore.setState({ models: new Map([['p1', [{ ...model, contextWindow: 100 }]]]) });
    useChatStore.setState({
      messages: Array.from({ length: 13 }, (_, index) => ({
        id: `old-${index}`, conversationId: 'conv1', role: 'user' as const,
        content: 'x'.repeat(120), createdAt: index,
      })),
    });

    await useChatStore.getState().sendMessage('trigger compaction', 'p1', 'gpt-test');

    expect(streamCalls).toHaveLength(2);
    expect(streamCalls[0].emitChunks).toBe(false);
    expect(created.some((message) => message.content === 'main answer after compaction failure')).toBe(true);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('compacts against the conversation model window, not the selected one', async () => {
    // The run uses the 100-token model while a 1M model is selected: the
    // compaction guard must still trigger. Reading the selected model here
    // (as before) computed a 256k budget and skipped compaction entirely.
    const big = { ...model, id: 'big', name: 'Big', contextWindow: 1_000_000 };
    const small = { ...model, contextWindow: 100 };
    useModelStore.setState({
      models: new Map([['p1', [small, big]]]),
      selectedModelId: 'big',
      selectedProviderId: 'p1',
    });
    useChatStore.setState({
      messages: Array.from({ length: 13 }, (_, index) => ({
        id: `old-${index}`, conversationId: 'conv1', role: 'user' as const,
        content: 'x'.repeat(120), createdAt: index,
      })),
    });
    queued = [textResponse('compact summary'), textResponse('main answer')];

    await useChatStore.getState().sendMessage('trigger compaction', 'p1', 'gpt-test');

    expect(streamCalls).toHaveLength(2);
    expect(streamCalls[0].messages[0].content).toContain('compress');
    expect(created.some((message) => message.isSummary)).toBe(true);
    expect(created.some((message) => message.content === 'main answer')).toBe(true);
  });

  it('picks up a limit edit on the next turn of the same run', async () => {
    // A context/max-output edit mid-run must reach the following turn without
    // waiting for the user to send another message.
    useModelStore.setState({ models: new Map([['p1', [model]]]) });
    queued = [toolCallResponse('read_file', { path: '/proj/a.ts' }), textResponse('done')];
    const origRead = window.electronAPI.fs.readFile;
    window.electronAPI.fs.readFile = async (p: string) => {
      useModelStore.getState().setModelLimits('p1', 'gpt-test', { maxOutputTokens: 7777 });
      return origRead(p);
    };

    await useChatStore.getState().sendMessage('read it', 'p1', 'gpt-test');

    expect(streamCalls).toHaveLength(2);
    expect(streamCalls[0].maxTokens).toBe(8192);
    expect(streamCalls[1].maxTokens).toBe(7777);
  });

  it('lets the model drive a project push through the GitHub plugin tool', async () => {
    const { useMarketStore } = await import('./market.store');
    const pushProject = vi.fn(async () => ({ ok: true, message: 'Committed and pushed branch "main" to o/r.' }));
    (window as any).electronAPI.git.pushProject = pushProject;
    localStorage.setItem('conecode.pluginToken', 'tok');
    useMarketStore.setState({ repo: 'o/r', result: null });
    try {
      queued = [toolCallResponse('github_push', { message: 'Ship it' }), textResponse('done')];

      const sending = useChatStore.getState().sendMessage('push my changes', 'p1', 'gpt-test');
      await vi.waitFor(() => expect(useGithubPushStore.getState().pending).not.toBeNull());
      expect(pushProject).not.toHaveBeenCalled();
      useGithubPushStore.getState().confirm('o/r');
      await sending;

      expect(pushProject).toHaveBeenCalledWith({ cwd: '/proj', message: 'Ship it', repo: 'o/r', token: 'tok' });
      expect(streamCalls).toHaveLength(2);
      expect(JSON.stringify(streamCalls[1].messages)).toContain('Committed and pushed');
      expect(created.some((m) => m.content === 'done')).toBe(true);
    } finally {
      localStorage.removeItem('conecode.pluginToken');
      useMarketStore.setState({ repo: '', result: null });
    }
  });

  it('refuses GitHub tool calls while the plugin is disabled', async () => {
    const { usePluginStore } = await import('./plugin.store');
    usePluginStore.setState({ disabled: ['github-sync'] });
    const pushProject = vi.fn();
    (window as any).electronAPI.git.pushProject = pushProject;
    try {
      queued = [toolCallResponse('github_push', {}), textResponse('done')];

      await useChatStore.getState().sendMessage('push my repo', 'p1', 'gpt-test');

      expect(pushProject).not.toHaveBeenCalled();
      expect(streamCalls).toHaveLength(2);
      expect(JSON.stringify(streamCalls[1].messages)).toContain('plugin is disabled');
    } finally {
      usePluginStore.setState({ disabled: [] });
    }
  });

  it('feeds a failed project push back to the model', async () => {
    const { useMarketStore } = await import('./market.store');
    const pushProject = vi.fn(async () => ({ ok: false, message: 'The project has no origin remote.' }));
    (window as any).electronAPI.git.pushProject = pushProject;
    useMarketStore.setState({ repo: '', result: null });
    queued = [toolCallResponse('github_push', {}), textResponse('done')];

    const sending = useChatStore.getState().sendMessage('push my changes', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(useGithubPushStore.getState().pending).not.toBeNull());
    useGithubPushStore.getState().confirm('o/r');
    await sending;

    expect(streamCalls).toHaveLength(2);
    expect(JSON.stringify(streamCalls[1].messages)).toContain('Error: The project has no origin remote.');
  });

  it('runs two conversations concurrently, even on the same model', async () => {
    window.electronAPI.message.list = vi.fn(async (id: string): Promise<Message[]> =>
      id === 'conv1'
        ? [{ id: 'm1', conversationId: 'conv1', role: 'user', content: 'first chat', createdAt: 1 }]
        : [{ id: 'm2', conversationId: 'conv2', role: 'user', content: 'second chat', createdAt: 2 }],
    );
    const resolvers = new Map<string, (value: any) => void>();
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      const last = params.messages[params.messages.length - 1].content;
      streamCalls.push(params);
      return new Promise((resolve) => { resolvers.set(last, resolve); });
    });
    useChatStore.setState({
      conversations: [
        { id: 'conv1', title: 'One', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 },
        { id: 'conv2', title: 'Two', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 },
      ],
    });

    // Start conv1's run and, while it is still streaming, start conv2's too.
    const sending1 = useChatStore.getState().sendMessage('first chat', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(1));
    await useChatStore.getState().setActiveConversation('conv2');
    const sending2 = useChatStore.getState().sendMessage('second chat', 'p1', 'gpt-test');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(2));

    // Each run streams into its own buffer.
    expect(Object.keys(useChatStore.getState().streamingRuns).sort()).toEqual(['conv1', 'conv2']);

    // Finish them out of order; each answer must land in its own transcript.
    resolvers.get('second chat')!(textResponse('answer two'));
    await sending2;
    expect(useChatStore.getState().streamingRuns['conv2']).toBeUndefined();
    expect(useChatStore.getState().streamingRuns['conv1']).toBeDefined();

    resolvers.get('first chat')!(textResponse('answer one'));
    await Promise.all([sending1]);
    expect(useChatStore.getState().streamingRuns).toEqual({});
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(created.some((m) => m.conversationId === 'conv1' && m.content === 'answer one')).toBe(true);
    expect(created.some((m) => m.conversationId === 'conv2' && m.content === 'answer two')).toBe(true);
  });

  it('ignores a slower conversation load after a newer switch wins', async () => {
    let releaseConv2!: (value: any[]) => void;
    const conv3Message = {
      id: 'conv3-message', conversationId: 'conv3', role: 'user' as const,
      content: 'latest chat', createdAt: 1,
    };
    window.electronAPI.message.list = vi.fn((id: string) =>
      id === 'conv2'
        ? new Promise<any[]>((resolve) => { releaseConv2 = resolve; })
        : Promise.resolve([conv3Message]),
    );
    useChatStore.setState({
      conversations: [
        { id: 'conv1', title: 'One', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 },
        { id: 'conv2', title: 'Two', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 },
        { id: 'conv3', title: 'Three', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 },
      ],
    });

    const first = useChatStore.getState().setActiveConversation('conv2');
    await Promise.resolve();
    await useChatStore.getState().setActiveConversation('conv3');
    releaseConv2([]);
    await first;

    expect(useChatStore.getState().activeConversationId).toBe('conv3');
    expect(useChatStore.getState().messages).toEqual([conv3Message]);
  });

  it('stitches a length-truncated reply seamlessly instead of stopping', async () => {
    const lengthResponse = (content: string) => ({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'length' }],
    });
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      return streamCalls.length === 1 ? lengthResponse('part one ') : textResponse('part two');
    });

    await useChatStore.getState().sendMessage('write a long answer', 'p1', 'gpt-test');

    expect(streamCalls).toHaveLength(2);
    // Second request resumes from the partial with a continue prompt.
    const second = JSON.stringify(streamCalls[1].messages);
    expect(second).toContain('part one ');
    // One stitched message, no truncation error, no extra scaffolding saved.
    const assistants = useChatStore.getState().messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe('part one part two');
    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().continuableConvId).toBeNull();
  });

  it('still executes a tool call that arrived with a length finish', async () => {
    queued = [
      {
        choices: [{
          message: {
            role: 'assistant', content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/proj/a.ts"}' } }],
          },
          finish_reason: 'length',
        }],
      },
      textResponse('done'),
    ];

    await useChatStore.getState().sendMessage('read it', 'p1', 'gpt-test');

    const toolResult = useChatStore.getState().messages.find((m) => m.role === 'tool');
    expect(toolResult!.content).toContain('file body');
    expect(streamCalls).toHaveLength(2);
  });

  it('resumes from a dropped stream partial instead of restarting the turn', async () => {
    let attempts = 0;
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      attempts++;
      if (attempts === 1) {
        // Simulate tokens that already reached the live view, then a drop.
        useChatStore.setState((s) => ({
          streamingRuns: {
            ...s.streamingRuns,
            conv1: { ...(s.streamingRuns.conv1 || { reasoningContent: '', status: 'writing', toolName: null }), content: 'partial text here ' },
          },
        }));
        throw new Error('Incomplete model stream: missing completion marker');
      }
      return textResponse('continued.');
    });

    await useChatStore.getState().sendMessage('keep going', 'p1', 'gpt-test');

    expect(streamCalls).toHaveLength(2);
    // The retry resumed from the partial rather than replaying the base turn.
    expect(JSON.stringify(streamCalls[1].messages)).toContain('partial text here ');
    const assistants = useChatStore.getState().messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe('partial text here continued.');
    expect(useChatStore.getState().error).toBeNull();
  });

  it('marks a salvaged interruption and offers one-click continuation', async () => {
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      useChatStore.setState((s) => ({
        streamingRuns: {
          ...s.streamingRuns,
          conv1: { ...(s.streamingRuns.conv1 || { reasoningContent: '', status: 'writing', toolName: null }), content: 'half an answer' },
        },
      }));
      throw new Error('provider exploded');
    });

    await useChatStore.getState().sendMessage('go', 'p1', 'gpt-test');

    const salvaged = useChatStore.getState().messages.find((m) => m.role === 'assistant');
    expect(salvaged!.content).toContain('half an answer');
    expect(salvaged!.interrupted).toBe(true);
    expect(useChatStore.getState().continuableConvId).toBe('conv1');

    // One click continues the conversation with a continue prompt.
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      return textResponse('the rest');
    });
    await useChatStore.getState().continueGeneration('conv1');

    const continued = useChatStore.getState().messages.filter((m) => m.role === 'user').pop();
    expect(continued!.content).toBe(useLanguageStore.getState().t('continuePrompt'));
    expect(useChatStore.getState().continuableConvId).toBeNull();
  });

  it('leaves a persisted trace when a stream dies with nothing to salvage', async () => {
    // No partial content is placed in the run buffer, so the catch path hits
    // the empty-salvage branch — previously it set only an in-memory error,
    // leaving the dangling request as the last message after a reload.
    window.electronAPI.chat.stream = vi.fn(async (params: any) => {
      streamCalls.push(params);
      throw new Error('API error 401: bad key');
    });

    await useChatStore.getState().sendMessage('go', 'p1', 'gpt-test');

    const notice = created.find((m) => (m as any).isLocalNotice);
    expect(notice).toBeDefined();
    expect(notice!.role).toBe('assistant');
    expect(notice!.content).toContain(useLanguageStore.getState().t('runDiedNotice'));
    expect(notice!.content).toContain('bad key');
    expect(useChatStore.getState().error).toContain('bad key');
    expect(useChatStore.getState().continuableConvId).toBe('conv1');
    // The notice is visible in the transcript, never sent to the model.
    expect(useChatStore.getState().messages.some((m) => (m as any).isLocalNotice)).toBe(true);
  });

  it('auto-runs commands under an approval override without touching settings', async () => {
    // RSI-style: the stored mode stays suggest, execution still goes fullAuto.
    (window as any).electronAPI.exec = {
      run: async () => ({ success: true, stdout: 'ok', stderr: '', exitCode: 0 }),
    };
    useSettingsStore.setState({ approvalMode: 'suggest', approvalOverride: 'fullAuto' });
    try {
      queued = [toolCallResponse('exec', { command: 'ls' }), textResponse('done')];

      await useChatStore.getState().sendMessage('run it', 'p1', 'gpt-test');

      expect(streamCalls).toHaveLength(2);
      expect(useCodeChangesStore.getState().changes.every((c) => c.status !== 'pending')).toBe(true);
      expect(useSettingsStore.getState().approvalMode).toBe('suggest');
      expect(useChatStore.getState().error).toBeNull();
    } finally {
      useSettingsStore.setState({ approvalOverride: null });
    }
  });
});
