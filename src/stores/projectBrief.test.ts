import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectBriefStore } from './projectBrief.store';
import { useModelStore } from './model.store';

let streamCalls: any[] = [];
let replies: any[] = [];

const truncated = { choices: [{ message: { content: '', reasoning_content: 'thinking…' }, finish_reason: 'length' }] };
const answer = (prompt: string) => ({
  choices: [{ message: { content: JSON.stringify({ title: 'Ledger', prompt }) }, finish_reason: 'stop' }],
});

beforeEach(() => {
  streamCalls = [];
  replies = [];
  localStorage.clear();
  (globalThis as any).window = {
    electronAPI: {
      chat: {
        stream: async (params: any) => {
          streamCalls.push(params);
          return replies.shift() ?? answer('Build it.');
        },
      },
    },
  };
  useModelStore.setState({
    models: new Map([['p', [{ id: 'm', providerId: 'p', maxOutputTokens: 8192 }]]]) as any,
    selectedModelId: 'm',
    selectedProviderId: 'p',
  });
  useProjectBriefStore.setState({
    idea: '', brief: null, prompt: '', generating: false, starting: false,
    error: null, errorDetail: null, directory: null,
  });
});

describe('project brief generation', () => {
  it('retries with a larger budget when the model spends it all on reasoning', async () => {
    replies = [truncated, answer('Complete development prompt.')];
    useProjectBriefStore.getState().setIdea('A local-first bookkeeping app');

    await useProjectBriefStore.getState().generate('p', 'm', 'en');

    expect(streamCalls.map((c) => c.maxTokens)).toEqual([8192, 16384]);
    expect(useProjectBriefStore.getState().brief).toEqual({ title: 'Ledger', prompt: 'Complete development prompt.' });
    expect(useProjectBriefStore.getState().error).toBeNull();
  });

  it('climbs to the ceiling when the first retry is still truncated', async () => {
    replies = [truncated, truncated, answer('Final prompt.')];
    useProjectBriefStore.getState().setIdea('A local-first bookkeeping app');

    await useProjectBriefStore.getState().generate('p', 'm', 'en');

    expect(streamCalls.map((c) => c.maxTokens)).toEqual([8192, 16384, 32000]);
    expect(useProjectBriefStore.getState().prompt).toBe('Final prompt.');
  });

  it('surfaces the real cause instead of a connection error', async () => {
    (globalThis as any).window.electronAPI.chat.stream = async () => { throw new Error('401 Invalid API key'); };
    useProjectBriefStore.getState().setIdea('A local-first bookkeeping app');

    await useProjectBriefStore.getState().generate('p', 'm', 'en');

    expect(useProjectBriefStore.getState().error).toBe('briefErrorAuth');
    expect(useProjectBriefStore.getState().errorDetail).toContain('401');
  });
});
