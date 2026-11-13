import { describe, expect, it, vi } from 'vitest';
import { completeDream } from './completion';
import { runDream } from './index';
import { indexJsonKey, readIndexJson, stateKey } from './wiki';

const request = { system: 'Extract durable facts.', user: 'An idle transcript.', maxTokens: 4000 };

describe('Dream model output', () => {
  it('recovers a previously failing session after the model runs out of reasoning tokens', async () => {
    const objects = new Map<string, string>();
    const storage = {
      getObject: (key: string) => objects.get(key) ?? null,
      putObject: (key: string, content: string) => { objects.set(key, content); return true; },
    };
    const session = {
      id: 'idle-session', title: 'Release validation', updatedAt: 1_800_000_000_000 - 3_600_000,
      messages: [
        { role: 'user' as const, content: 'Where do the release artifacts go?' },
        { role: 'assistant' as const, content: 'The verified macOS artifacts land in the release directory.' },
      ],
    };
    const opts = { scope: 'default', now: 1_800_000_000_000, sessions: [session] };
    const old = await runDream(storage, async () => 'I should think through this transcript...', opts);
    expect(old.sessions[0]?.status).toBe('failed');
    expect(JSON.parse(objects.get(stateKey('default'))!).processed).toEqual({});

    const send = vi.fn()
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'length', message: {
        content: '', reasoning_content: '{"files":[]}',
      } }] })
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ files: [{
          slug: 'release-artifacts', name: 'Release artifacts',
          body: 'The verified macOS artifacts land in the release directory.',
        }] }),
      } }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"merges":[],"retire":[]}' }] });

    const report = await runDream(storage, (req) => completeDream(req, 32_000, send), opts);
    expect(send.mock.calls.map(([call]) => call.maxTokens)).toEqual([8192, 16384, 8192]);
    expect(report.sessions[0]).toMatchObject({ status: 'analyzed', files: ['release-artifacts'] });
    expect(readIndexJson(objects.get(indexJsonKey('default')) ?? null).map((entry) => entry.slug))
      .toEqual(['release-artifacts']);
  });

  it('respects a small provider limit and rejects a second truncated final answer', async () => {
    const send = vi.fn().mockResolvedValue({
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"files":[]}' }] } }],
    });
    await expect(completeDream(request, 4096, send)).rejects.toThrow('token limit');
    expect(send.mock.calls.map(([call]) => call.maxTokens)).toEqual([4096, 4096]);
  });

  it('retries prose and discards inline reasoning before reading final JSON', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'There is nothing to report.' }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '<think>{"files":[{}]}</think>{"files":[]}' } }] });
    expect(await completeDream(request, undefined, send)).toBe('{"files":[]}');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
