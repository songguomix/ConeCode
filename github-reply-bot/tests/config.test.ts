import { describe, expect, it } from 'vitest';
import { loadConfig, resolveDatabasePath } from '../src/server/config';

describe('configuration loading', () => {
  it('treats empty environment values as missing instead of throwing', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      ADMIN_TOKEN: '',
      GITHUB_APP_ID: '',
      GITHUB_PRIVATE_KEY: '',
      GITHUB_WEBHOOK_SECRET: '',
      GITHUB_APP_SLUG: '',
      LLM_ENDPOINT: '',
      LLM_MODEL: '',
      DATABASE_URL: '',
    });
    expect(config.adminToken).toBeNull();
    expect(config.github.appId).toBeNull();
    expect(config.github.webhookSecret).toBeNull();
    expect(config.llm.endpoint).toBeNull();
    expect(config.llm.model).toBe('gpt-4o-mini');
    expect(config.missingConfig).toEqual(
      expect.arrayContaining(['ADMIN_TOKEN', 'GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'])
    );
    expect(config.databasePath).toContain('data/reply-bot.db');
  });

  it('still fails fast on malformed values', () => {
    expect(() => loadConfig({ GITHUB_APP_ID: 'not-a-number' })).toThrow(/GITHUB_APP_ID/);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid environment configuration/);
    expect(() => loadConfig({ LLM_TIMEOUT_MS: '10' })).toThrow(/LLM_TIMEOUT_MS/);
  });

  it('loads escaped newlines in the private key', () => {
    const config = loadConfig({
      GITHUB_APP_ID: '123',
      GITHUB_PRIVATE_KEY: 'line1\\nline2',
      GITHUB_WEBHOOK_SECRET: 'secret',
    });
    expect(config.github.privateKey).toBe('line1\nline2');
  });

  it('resolves database paths', () => {
    expect(resolveDatabasePath(':memory:')).toBe(':memory:');
    expect(resolveDatabasePath('file::memory:')).toBe(':memory:');
    expect(resolveDatabasePath('file:./data/x.db')).toContain('data/x.db');
    expect(resolveDatabasePath('/tmp/abs.db')).toBe('/tmp/abs.db');
  });
});
