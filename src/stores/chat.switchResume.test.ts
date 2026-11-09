import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIModel } from '../types';
import { useChatStore } from './chat.store';
import { useModelStore } from './model.store';
import { useUIStore } from './ui.store';
import { useWorkspaceStore } from './workspace.store';

const model: AIModel = {
  id: 'gpt-test', name: 'GPT Test', providerId: 'p1',
  supportsText: true, supportsVision: false, supportsImageGeneration: false,
  supportsAudioInput: false, supportsAudioOutput: false,
  supportsFunctionCalling: true, supportsReasoning: false,
  contextWindow: 128000, maxOutputTokens: 8192, enabled: true,
};

const textResponse = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

let streamCalls: any[] = [];
let created: any[] = [];

function installStubs() {
  streamCalls = [];
  created = [];
  (globalThis as any).window = {
    electronAPI: {
      chat: {
        stream: async (params: any) => {
          streamCalls.push(params);
          return textResponse('finished the approved step');
        },
        stop: async () => true,
      },
      message: {
        create: async (m: any) => { created.push(m); return m; },
        list: async () => [],
        delete: async () => true,
      },
      conversation: {
        create: async (d: any) => ({ id: 'convX', title: 'New Chat', ...d, createdAt: 0, updatedAt: 0 }),
        update: async () => {},
        list: async () => [],
      },
      fs: {
        readFile: async () => null,
        writeFile: async () => true,
        readDir: async () => [],
        exists: async () => false,
        createDir: async () => true,
        stat: async () => ({ size: 0, isDirectory: false, isFile: true, createdAt: '', modifiedAt: '' }),
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

const conversation = (id: string, title: string) => ({
  id, title, providerId: 'p1', modelId: 'gpt-test',
  rootPath: '/proj', isChatMode: false, agentMode: 'standard' as const,
  createdAt: 0, updatedAt: 0,
});

describe('approval continuation across conversation switches', () => {
  beforeEach(() => {
    installStubs();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    useModelStore.setState({ models: new Map([['p1', [model]]]) });
    useUIStore.setState({ viewMode: 'work' });
    useWorkspaceStore.setState({ rootPath: '/proj' } as any);
    useChatStore.setState({
      conversations: [conversation('convA', 'Task'), conversation('convB', 'Other')] as any,
      activeConversationId: 'convB',
      messages: [],
      isStreaming: false,
      streamingRuns: {},
      error: null,
      agentMode: 'standard',
      planMode: false,
      reviewMode: false,
    });
  });

  it('resumes the turn in its own conversation while another chat is on screen', async () => {
    // The user switched chats (or opened a new one) while an approval was
    // resolving. The approved outcome must still restart the turn in convA —
    // it may never be dropped just because convA is no longer the active view.
    await useChatStore.getState().feedToolResults('convA', 'p1', 'gpt-test', 'command succeeded');

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].conversationId).toBe('convA');

    // The finished turn is persisted for convA...
    expect(created.some((m) => m.conversationId === 'convA' && m.content === 'finished the approved step')).toBe(true);

    // ...without hijacking the conversation the user is looking at.
    expect(useChatStore.getState().activeConversationId).toBe('convB');
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().streamingRuns.convA).toBeUndefined();
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('still appends the outcome to the live transcript when it is on screen', async () => {
    useChatStore.setState({ activeConversationId: 'convA', messages: [] });

    await useChatStore.getState().feedToolResults('convA', 'p1', 'gpt-test', 'command succeeded');

    const contents = useChatStore.getState().messages.map((m) => m.content);
    expect(contents).toContain('command succeeded');
    expect(contents).toContain('finished the approved step');
    expect(streamCalls).toHaveLength(1);
  });
});
