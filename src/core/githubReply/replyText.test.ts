import { describe, expect, it } from 'vitest';
import {
  buildReplyDraft,
  findSensitive,
  resolveReplyLanguage,
  sanitizeReply,
} from './replyText';
import type { ReplyThreadContext } from '../../types/githubReply.types';

function context(overrides: Partial<ReplyThreadContext> = {}): ReplyThreadContext {
  return {
    repo: 'acme/widgets',
    number: 7,
    title: 'Crash when starting the app',
    body: 'Steps to reproduce: run the app. Expected: it starts. Actual: crash. Version 1.2.3.',
    author: 'alice',
    labels: ['bug'],
    comments: 1,
    updatedAt: '2025-01-01T00:00:00Z',
    url: 'https://github.com/acme/widgets/issues/7',
    isPullRequest: false,
    state: 'open',
    recentComments: [{ id: 1, author: 'bob', body: 'I can reproduce this.', createdAt: '2025-01-02T00:00:00Z' }],
    ...overrides,
  };
}

describe('reply text helpers', () => {
  it('detects language from content', () => {
    expect(resolveReplyLanguage('启动崩溃', '复现步骤…', 'auto')).toBe('zh');
    expect(resolveReplyLanguage('App crashes', 'Steps to reproduce…', 'auto')).toBe('en');
    expect(resolveReplyLanguage('中文', '中文', 'en')).toBe('en');
  });

  it('builds an acknowledgement draft with context', () => {
    const draft = buildReplyDraft(context(), { language: 'en' });
    expect(draft).toContain('alice');
    expect(draft).toContain('acme/widgets · #7');
    expect(draft).toContain('bug');
    expect(draft).not.toContain('@');
  });

  it('asks for details when the report is thin', () => {
    const draft = buildReplyDraft(context({ body: 'broken' }), { language: 'zh' });
    expect(draft).toContain('复现步骤');
    expect(draft).toContain('alice');
  });

  it('builds a PR checklist draft', () => {
    const draft = buildReplyDraft(
      context({ isPullRequest: true, number: 9, title: 'Add caching', body: 'Adds a cache.' }),
      { language: 'en' }
    );
    expect(draft).toContain('pull request');
    expect(draft).toContain('acme/widgets#9');
    expect(draft).toContain('- [ ]');
  });

  it('blocks secret-looking replies', () => {
    expect(findSensitive('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('github_token');
    const result = sanitizeReply('use ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('sensitive');
  });

  it('rejects empty replies', () => {
    expect(sanitizeReply('   ')).toMatchObject({ ok: false, code: 'empty' });
  });

  it('removes mass mentions and enforces the length limit', () => {
    const mentions = sanitizeReply('@everyone see this');
    expect(mentions.ok).toBe(true);
    if (mentions.ok) expect(mentions.body).not.toContain('@everyone');

    const long = sanitizeReply('a'.repeat(5000), 500);
    expect(long.ok).toBe(true);
    if (long.ok) expect(long.body.length).toBeLessThanOrEqual(500);
  });
});
