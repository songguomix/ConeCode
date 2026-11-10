import { describe, expect, it } from 'vitest';
import { formatTranscript, isDreamEligible } from './transcript';
import type { DreamSession } from './types';

function session(overrides: Partial<DreamSession> = {}): DreamSession {
  return {
    id: 's1',
    title: 'Fix the build',
    updatedAt: 1_800_000_000_000,
    messages: [
      { role: 'user', content: 'how do I build?' },
      {
        role: 'assistant',
        content: 'running the build',
        toolCalls: ['exec({"command":"npm run build"})'],
      },
      { role: 'tool', toolName: 'exec', content: 'built successfully' },
    ],
    ...overrides,
  };
}

describe('dream transcripts', () => {
  it('includes tool call names and arguments, redacted', () => {
    const text = formatTranscript(
      session({
        messages: [
          { role: 'user', content: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
          {
            role: 'assistant',
            content: 'calling',
            toolCalls: ['exec({"command":"echo ghp_abcdefghijklmnopqrstuvwxyz0123456789"})'],
          },
          { role: 'tool', toolName: 'exec', content: 'done' },
        ],
      })
    );
    expect(text).toContain('[calls] exec({"command"');
    expect(text).not.toContain('ghp_');
    expect(text).toContain('[tool:exec]');
  });

  it('truncates long transcripts', () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: 'x'.repeat(3000),
    }));
    const text = formatTranscript(session({ messages }), 6000);
    expect(text.length).toBeLessThanOrEqual(6100);
    expect(text).toContain('[transcript truncated]');
  });

  it('requires idle sessions with real exchanges', () => {
    const now = 1_800_000_000_000;
    expect(isDreamEligible(session({ updatedAt: now - 3_600_000 }), now, 10 * 60_000)).toBe(true);
    expect(isDreamEligible(session({ updatedAt: now - 1000 }), now, 10 * 60_000)).toBe(false);
    expect(
      isDreamEligible(
        session({ messages: [{ role: 'user', content: 'only a question' }] }),
        now,
        10 * 60_000
      )
    ).toBe(false);
  });
});
