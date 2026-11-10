import { describe, expect, it } from 'vitest';
import { findSensitive, sanitizeReply } from '../src/server/safety/filter';

describe('safety filter', () => {
  it('passes normal replies through', () => {
    const result = sanitizeReply('Thanks for the report, alice!\n\nA maintainer will take a look.', { maxChars: 2000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toContain('alice');
  });

  it('rejects empty replies', () => {
    expect(sanitizeReply('   \n  ', { maxChars: 2000 })).toMatchObject({ ok: false, code: 'empty_reply' });
  });

  it('blocks secret-like strings', () => {
    const tokens = [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'sk-abcdefghijklmnopqrstuvwxyz012345',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
      '-----BEGIN RSA PRIVATE KEY-----',
      'password: hunter2hunter2',
    ];
    for (const token of tokens) {
      const result = sanitizeReply(`Here is the value ${token}`, { maxChars: 2000 });
      expect(result.ok, token).toBe(false);
      if (!result.ok) expect(result.code).toBe('blocked_sensitive');
    }
  });

  it('finds sensitive patterns directly', () => {
    expect(findSensitive('nothing here')).toBeNull();
    expect(findSensitive('token AKIAABCDEFGHIJKLMNOP')?.name).toBe('aws_access_key');
  });

  it('removes mass mentions', () => {
    const result = sanitizeReply('Hey @everyone and @channel and @here, look at this', { maxChars: 2000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).not.toContain('@everyone');
      expect(result.body).not.toContain('@channel');
      expect(result.body).not.toContain('@here');
      expect(result.warnings).toContain('mass_mention_removed');
    }
  });

  it('caps the number of mentions', () => {
    const result = sanitizeReply('cc @a @b @c @d @e', { maxChars: 2000, maxMentions: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const mentions = result.body.match(/@[A-Za-z0-9-]+/g) ?? [];
      expect(mentions.length).toBeLessThanOrEqual(2);
      expect(result.warnings).toContain('mention_limit_applied');
    }
  });

  it('truncates over-long replies to the configured limit', () => {
    const result = sanitizeReply('a'.repeat(5000), { maxChars: 400 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.length).toBeLessThanOrEqual(400);
      expect(result.warnings).toContain('truncated');
    }
  });
});
