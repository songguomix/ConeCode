import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore, buildApiMessages, resetNativeToolFallback } from './chat.store';
import { useWorkspaceStore } from './workspace.store';
import { useModelStore } from './model.store';
import { useSettingsStore } from './settings.store';
import { useTodosStore } from './todos.store';
import { useMemoryStore } from './memory.store';
import { useCodeChangesStore } from './codeChanges.store';
import type { AIModel, Message } from '../types';

// Attached images belong to the turn that sent them: rendered in the
// transcript, delivered to the model exactly once, gone from the composer.

let streamCalls: any[];
let transcripts: Record<string, any[]>;

const model: AIModel = {
  id: 'gpt-test', name: 'GPT Test', providerId: 'p1',
  supportsText: true, supportsVision: true, supportsImageGeneration: false,
  supportsAudioInput: false, supportsAudioOutput: false,
  supportsFunctionCalling: true, supportsReasoning: false,
  contextWindow: 128000, maxOutputTokens: 8192, enabled: true,
};

const textResponse = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

const IMG_A = 'data:image/png;base64,AAAA';
const IMG_B = 'data:image/png;base64,BBBB';
const IMG_C = 'data:image/png;base64,CCCC';

function installStubs() {
  streamCalls = [];
  transcripts = {};
  (globalThis as any).window = {
    electronAPI: {
      chat: {
        stream: async (params: any) => { streamCalls.push(params); return textResponse('got it'); },
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

function resetStores() {
  useModelStore.setState({ models: new Map([['p1', [model]]]), selectedModelId: 'gpt-test' });
  useSettingsStore.setState({ toolCallMode: 'auto', approvalMode: 'suggest', autoIncludeFileContext: false });
  useWorkspaceStore.setState({
    rootPath: '/proj', mcpTools: [], contextFiles: [], selectedFile: null,
    fileContent: null, agentsMd: null, selectedFileIsImage: false,
  });
  useTodosStore.getState().clearTodos();
  useChatStore.setState({
    messages: [],
    conversations: [{ id: 'conv1', title: 'New Chat', providerId: 'p1', modelId: 'gpt-test', createdAt: 0, updatedAt: 0 }],
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

beforeEach(() => {
  installStubs();
  resetNativeToolFallback();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetStores();
});

const userMessages = () => (transcripts['conv1'] || []).filter((m) => m.role === 'user' && !m.isToolResult);

describe('sending attached images', () => {
  it('rides the user message, leaves the composer, and reaches the model exactly once', async () => {
    useWorkspaceStore.setState({
      contextFiles: [
        { path: 'shot.png', content: '', isImage: true, dataUrl: IMG_A },
        { path: 'notes.md', content: 'hello', isImage: false },
      ],
    });

    await useChatStore.getState().sendMessage('look at this', 'p1', 'gpt-test');

    // The transcript user message carries the picture.
    const sent = userMessages()[0];
    expect(sent.images).toEqual([IMG_A]);
    expect(sent.content).toBe('look at this');

    // The composer no longer holds the image; text context files stay.
    const files = useWorkspaceStore.getState().contextFiles;
    expect(files.some((f) => f.isImage)).toBe(false);
    expect(files.some((f) => f.path === 'notes.md')).toBe(true);

    // The model receives the image ONCE, as part of the user turn — not as a
    // per-turn injected "[Attached image]" context message.
    const request = streamCalls[0].messages;
    const occurrences = JSON.stringify(request).split(IMG_A).length - 1;
    expect(occurrences).toBe(1);
    expect(JSON.stringify(request)).not.toContain('[Attached image:');
    const userTurn = request.find((m: any) => Array.isArray(m.content) && JSON.stringify(m.content).includes(IMG_A));
    expect(userTurn.role).toBe('user');
    expect(userTurn.content.some((p: any) => p.type === 'text' && p.text === 'look at this')).toBe(true);
  });

  it('supports an image-only send without clobbering the auto title', async () => {
    useWorkspaceStore.setState({
      contextFiles: [{ path: 'shot.png', content: '', isImage: true, dataUrl: IMG_A }],
    });

    await useChatStore.getState().sendMessage('', 'p1', 'gpt-test');

    const sent = userMessages()[0];
    expect(sent.images).toEqual([IMG_A]);
    expect(sent.content).toBe('');
    // An image-only first turn keeps the conversation title instead of ''.
    expect(useChatStore.getState().conversations[0].title).toBe('New Chat');
  });

  it('replays recent image turns as vision parts and old ones as a placeholder', () => {
    const live: Message[] = [
      { id: 'm0', conversationId: 'conv1', role: 'user', content: '', images: [IMG_A], createdAt: 1 },
      { id: 'a0', conversationId: 'conv1', role: 'assistant', content: 'first', createdAt: 2 },
      { id: 'm1', conversationId: 'conv1', role: 'user', content: 'what is this', images: [IMG_B], createdAt: 3 },
      { id: 'a1', conversationId: 'conv1', role: 'assistant', content: 'hmm', createdAt: 4 },
      { id: 'm2', conversationId: 'conv1', role: 'user', content: '', images: [IMG_C], createdAt: 5 },
    ];

    const out = buildApiMessages(live);

    // The two NEWEST image turns go over the wire as image parts.
    const withText = out.find((m) => Array.isArray(m.content) && JSON.stringify(m.content).includes(IMG_B));
    expect(withText?.role).toBe('user');
    expect((withText!.content as any[]).some((p) => p.type === 'image_url')).toBe(true);
    expect((withText!.content as any[]).some((p) => p.type === 'text' && p.text === 'what is this')).toBe(true);
    expect(out.filter((m) => Array.isArray(m.content)).length).toBe(2);

    // An image-only turn sends image parts WITHOUT an empty text block
    // (Anthropic rejects empty text blocks).
    const imageOnly = out.find((m) => Array.isArray(m.content) && JSON.stringify(m.content).includes(IMG_C));
    expect((imageOnly!.content as any[]).some((p) => p.type === 'text')).toBe(false);

    // An image turn that fell out of the wire window must not replay as an
    // empty user turn (providers reject that) — a text placeholder instead.
    const withPlaceholder = out.find((m) => typeof m.content === 'string' && m.content === '[image attachment]');
    expect(withPlaceholder).toBeTruthy();
  });
});
