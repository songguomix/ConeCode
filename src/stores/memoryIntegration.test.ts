import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from './chat.store';
import { useMemoryStore } from './memory.store';
import { useModelStore } from './model.store';
import { useSettingsStore } from './settings.store';
import { useWorkspaceStore } from './workspace.store';
import type { AIModel } from '../types';

// Proves the full memory loop: a turn is observed, a durable fact is stored,
// and the NEXT conversation is shaped by it.

let streamCalls: any[];
let queued: any[];
let saved: any[] | null;

const model: AIModel = {
  id: 'm1', name: 'M', providerId: 'p1',
  supportsText: true, supportsVision: false, supportsImageGeneration: false,
  supportsAudioInput: false, supportsAudioOutput: false,
  supportsFunctionCalling: false, supportsReasoning: false,
  contextWindow: 128000, maxOutputTokens: 8192, enabled: true,
};

const textResponse = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

beforeEach(() => {
  streamCalls = [];
  queued = [];
  saved = null;
  (globalThis as any).window = {
    electronAPI: {
      chat: {
        stream: async (params: any) => {
          streamCalls.push(params);
          return queued.shift() ?? textResponse('ok');
        },
        stop: async () => true,
      },
      message: { create: async (m: any) => m, delete: async () => true, list: async () => [] },
      conversation: { create: async (d: any) => ({ id: 'conv1', ...d }), update: async () => {}, list: async () => [] },
      memory: {
        list: async () => [],
        save: async (entries: any[]) => { saved = entries; return true; },
      },
      fs: { readFile: async () => null, exists: async () => false },
    },
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  useModelStore.setState({ models: new Map([['p1', [model]]]), selectedModelId: 'm1' });
  useSettingsStore.setState({ toolCallMode: 'prompt', autoIncludeFileContext: false, approvalMode: 'suggest' });
  useWorkspaceStore.setState({ rootPath: '/proj', mcpTools: [], contextFiles: [], selectedFile: null, fileContent: null, agentsMd: null });
  useChatStore.setState({ messages: [], activeConversationId: 'conv1', isStreaming: false, planMode: false, error: null });
  useMemoryStore.setState({ entries: [], enabled: true, extracting: false, loaded: true, turnsSinceExtraction: 0 });
});

describe('memory learning', () => {
  it('learns a durable fact from a finished turn and persists it', async () => {
    queued = [
      textResponse('Understood.'),
      // The extraction call that follows the visible turn.
      textResponse('{"memories":[{"kind":"style","scope":"global","text":"Writes in Chinese and wants answers in Chinese"}]}'),
    ];

    await useChatStore.getState().sendMessage('以后都用中文回答', 'p1', 'm1');
    await vi.waitFor(() => expect(useMemoryStore.getState().entries).toHaveLength(1));

    expect(useMemoryStore.getState().entries[0]).toMatchObject({
      kind: 'style',
      text: 'Writes in Chinese and wants answers in Chinese',
    });
    // ...and it survives a restart.
    expect(saved).toHaveLength(1);
  });

  it('sends the extractor the exchange plus what it already knows', async () => {
    useMemoryStore.setState({
      entries: [{
        id: 'e1', kind: 'workflow', text: 'Wants a plan before edits',
        scope: 'global', createdAt: 0, updatedAt: 0, hits: 1,
      }],
      turnsSinceExtraction: 2, // next turn is an extraction turn
    });
    queued = [textResponse('Sure.'), textResponse('{"memories":[]}')];

    await useChatStore.getState().sendMessage('fix the bug', 'p1', 'm1');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(2));

    const extraction = streamCalls[1];
    expect(extraction.silent, 'extraction must not touch the transcript').toBe(true);
    const prompt = extraction.messages.map((m: any) => m.content).join('\n');
    expect(prompt).toContain('fix the bug');
    expect(prompt).toContain('Wants a plan before edits'); // so it does not re-learn it
  });

  it('feeds what it knows into the next conversation', async () => {
    useMemoryStore.setState({ entries: [
      { id: 'a', kind: 'style', text: 'Prefers blunt, very short answers', scope: 'global', createdAt: 0, updatedAt: 0, hits: 3 },
      { id: 'b', kind: 'codeIssue', text: 'Often forgets to await async calls', scope: 'project', projectPath: '/proj', createdAt: 0, updatedAt: 0, hits: 2 },
      { id: 'c', kind: 'fact', text: 'Belongs to a different project', scope: 'project', projectPath: '/other', createdAt: 0, updatedAt: 0, hits: 1 },
    ] });
    queued = [textResponse('ok'), textResponse('{"memories":[]}')];

    await useChatStore.getState().sendMessage('hello', 'p1', 'm1');

    const systemText = streamCalls[0].messages
      .filter((m: any) => m.role === 'system')
      .map((m: any) => m.content)
      .join('\n');
    expect(systemText).toContain('Prefers blunt, very short answers');
    expect(systemText).toContain('Often forgets to await async calls');
    // Another project's memory must not leak into this workspace.
    expect(systemText).not.toContain('Belongs to a different project');
  });

  it('stays out of the prompt entirely when switched off', async () => {
    useMemoryStore.setState({
      enabled: false,
      entries: [{ id: 'a', kind: 'style', text: 'Prefers blunt answers', scope: 'global', createdAt: 0, updatedAt: 0, hits: 1 }],
    });
    queued = [textResponse('ok')];

    await useChatStore.getState().sendMessage('hello', 'p1', 'm1');

    const all = JSON.stringify(streamCalls[0].messages);
    expect(all).not.toContain('Prefers blunt answers');
    expect(streamCalls).toHaveLength(1); // and no extraction call either
  });

  it('never breaks the turn when extraction fails', async () => {
    queued = [textResponse('done')];
    (globalThis as any).window.electronAPI.chat.stream = async (params: any) => {
      streamCalls.push(params);
      if (streamCalls.length === 1) return textResponse('done');
      throw new Error('extractor exploded');
    };

    await useChatStore.getState().sendMessage('hi', 'p1', 'm1');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(2));

    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().messages.some((m) => m.content === 'done')).toBe(true);
  });

  it('reinforces a known fact rather than storing it twice', async () => {
    useMemoryStore.setState({
      entries: [{
        id: 'e1', kind: 'style', text: 'Prefers concise answers',
        scope: 'global', createdAt: 0, updatedAt: 0, hits: 1,
      }],
      turnsSinceExtraction: 2, // next turn is an extraction turn
    });
    queued = [
      textResponse('ok'),
      textResponse('{"memories":[{"kind":"style","scope":"global","text":"Prefers concise answers."}]}'),
    ];

    await useChatStore.getState().sendMessage('shorter please', 'p1', 'm1');
    await vi.waitFor(() => expect(useMemoryStore.getState().entries[0].hits).toBe(2));

    expect(useMemoryStore.getState().entries).toHaveLength(1);
  });
});

describe('extraction cadence', () => {
  it('learns from the very first turn', async () => {
    queued = [textResponse('ok'), textResponse('{"memories":[{"kind":"style","text":"Writes in Chinese"}]}')];
    await useChatStore.getState().sendMessage('第一句', 'p1', 'm1');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(2));
  });

  it('does not fire a second provider call on every subsequent turn', async () => {
    // Extraction is a whole extra round-trip; running it every turn would nearly
    // double the cost of a session.
    useMemoryStore.setState({ entries: [{
      id: 'e', kind: 'style', text: 'already knows something', scope: 'global',
      createdAt: 0, updatedAt: 0, hits: 1,
    }] });

    await useChatStore.getState().sendMessage('turn one', 'p1', 'm1');
    expect(streamCalls).toHaveLength(1); // chat only
    await useChatStore.getState().sendMessage('turn two', 'p1', 'm1');
    expect(streamCalls).toHaveLength(2); // still chat only

    // ...and then it catches up, with a window wide enough to see what it skipped.
    await useChatStore.getState().sendMessage('turn three', 'p1', 'm1');
    await vi.waitFor(() => expect(streamCalls).toHaveLength(4));
    const prompt = streamCalls[3].messages.map((m: any) => m.content).join('\n');
    expect(prompt).toContain('turn one');
    expect(prompt).toContain('turn three');
  });
});
