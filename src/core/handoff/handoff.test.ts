import { describe, expect, it } from 'vitest';
import { buildHandoffMarkdown, handoffFilename, handoffMessages, slugifyTitle } from './handoff';
import type { Message } from '../../types/chat.types';

const msg = (over: Partial<Message> & { role: Message['role']; content: string }): Message => ({
  id: Math.random().toString(36).slice(2),
  conversationId: 'c1',
  createdAt: 1700000000000,
  ...over,
});

describe('handoff', () => {
  it('names files safely with a timestamp', () => {
    expect(slugifyTitle('修 bug/加"引号"? *')).not.toMatch(/[/\\?%*:|"<>]/);
    expect(handoffFilename('My Chat', 1700000000000)).toMatch(/^conecode-handoff-My-Chat-\d{8}-\d{4}\.md$/);
    expect(handoffFilename('')).toContain('untitled');
  });

  it('keeps transcript turns but drops notices and system prompts', () => {
    const out = handoffMessages([
      msg({ role: 'system', content: 'huge system prompt' }),
      msg({ role: 'user', content: 'fix it' }),
      msg({ role: 'assistant', content: 'done', isLocalNotice: true }),
      msg({ role: 'assistant', content: '' }),
    ]);
    expect(out.map((m) => m.content)).toEqual(['fix it']);
  });

  it('renders the prompt first, caps tool payloads', () => {
    const big = 'x'.repeat(5000);
    const md = buildHandoffMarkdown({
      title: 'T',
      modelLabel: 'm1',
      projectPath: '/p',
      exportedAt: 1700000000000,
      prompt: 'TAKE OVER',
      howTo: 'drag me',
      messages: [
        msg({ role: 'user', content: 'go' }),
        msg({
          role: 'assistant',
          content: '',
          toolCalls: [{ id: '1', name: 'read_file', arguments: { path: '/a' } }],
        }),
        msg({ role: 'tool', content: big, toolName: 'read_file' }),
      ],
    });
    expect(md.indexOf('TAKE OVER')).toBeLessThan(md.indexOf('## TRANSCRIPT'));
    expect(md).toContain('Tool `read_file`');
    expect(md).toContain('truncated, 5000 chars total');
    expect(md).toContain('## TRANSCRIPT (3 turns)');
  });

  it('drops tool calls and results when switched off', () => {
    const base = {
      title: 'T', modelLabel: 'm', projectPath: '/p', exportedAt: 1,
      prompt: 'P', howTo: 'H',
      messages: [
        msg({ role: 'user', content: 'go' }),
        msg({ role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'x', arguments: {} }] }),
        msg({ role: 'tool', content: 'evidence', toolName: 'x' }),
      ],
    };
    const noTools = buildHandoffMarkdown({ ...base, includeTools: false });
    expect(noTools).not.toContain('Tool `x`');
    expect(noTools).toContain('evidence');
    const noResults = buildHandoffMarkdown({ ...base, includeToolResults: false });
    expect(noResults).toContain('Tool `x`');
    expect(noResults).not.toContain('evidence');
    expect(noResults).toContain('## TRANSCRIPT (2 turns)');
  });
});
