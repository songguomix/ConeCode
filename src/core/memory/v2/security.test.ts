import { describe, expect, it } from 'vitest';
import { createRecord } from './model';
import {
  decryptRecord, decryptText, encryptRecord, encryptText, isLoopback,
  safeLog, securitySummary, validateCloudTransport,
} from './security';
import type { CloudConfig } from './types';

const CONFIG: CloudConfig = {
  enabled: true,
  provider: 'rest',
  baseUrl: 'https://memory.example.com',
  authToken: 'secret-token',
  tenantId: 'tenant-a',
  autoSync: true,
  syncIntervalMs: 60_000,
  encryption: 'transport',
  e2ePassphrase: '',
  tlsOnly: true,
};

describe('cloud security boundaries', () => {
  it('round-trips an E2E envelope and never leaves plaintext in the payload', async () => {
    const payload = await encryptText('private project decision', 'correct horse battery staple');
    expect(payload.startsWith('e2e:v1:')).toBe(true);
    expect(payload).not.toContain('private project decision');
    expect(await decryptText(payload, 'correct horse battery staple')).toBe('private project decision');
    await expect(decryptText(payload, 'wrong passphrase')).rejects.toBeTruthy();
  });

  it('encrypts only the human-readable fields of a record', async () => {
    const record = createRecord({
      content: 'The cache key includes the tenant id',
      type: 'technical_decision',
      layer: 'global',
      tags: ['cache', 'tenant'],
      why: 'a cross-tenant cache hit leaked a name',
      sourceSessionId: 'session-sensitive',
    }, { id: 'm1', deviceId: 'dev-a', now: 1 });
    const encrypted = await encryptRecord(record, 'passphrase');
    expect(encrypted.title).toBe('[encrypted]');
    expect(encrypted.content.startsWith('e2e:v1:')).toBe(true);
    expect(encrypted.why).toBeUndefined();
    expect(encrypted.sourceSessionId).toBeUndefined();
    const decrypted = await decryptRecord(encrypted, 'passphrase');
    expect(decrypted.content).toBe(record.content);
    expect(decrypted.tags).toEqual(record.tags);
    expect(decrypted.sourceSessionId).toBe('session-sensitive');
  });

  it('refuses plain HTTP to a non-loopback host when TLS-only is on', () => {
    const config = { ...CONFIG, baseUrl: 'http://memory.example.com' };
    expect(validateCloudTransport(config).ok).toBe(false);
    expect(validateCloudTransport({ ...config, baseUrl: 'http://127.0.0.1:8791', tlsOnly: false }).ok).toBe(true);
    expect(isLoopback('http://localhost:8791')).toBe(true);
    expect(isLoopback('https://example.com')).toBe(false);
  });

  it('requires a passphrase when E2E is selected', () => {
    const e2e = { ...CONFIG, encryption: 'e2e' as const, e2ePassphrase: '' };
    expect(validateCloudTransport(e2e).ok).toBe(false);
    expect(validateCloudTransport({ ...e2e, e2ePassphrase: 'x' }).ok).toBe(true);
  });

  it('redacts credentials in diagnostic logs', () => {
    const line = safeLog('sync failed', CONFIG, 'HTTP 500');
    expect(line).toContain('tenant-a');
    expect(line).not.toContain('secret-token');
    expect(line).toContain('••');
  });

  it('describes Google Drive as an OAuth provider instead of a missing REST endpoint', () => {
    const summary = securitySummary({
      ...CONFIG,
      provider: 'google-drive',
      baseUrl: '',
      authToken: '',
      googleClientId: 'client-id',
    });
    expect(summary.transport).toContain('Google Drive');
    expect(summary.serverAtRest).toContain('Google');
    expect(summary.warnings.join(' ')).not.toContain('No cloud endpoint');
  });

  it('states the honest trade-off instead of claiming server-side search under E2E', () => {
    const summary = securitySummary({ ...CONFIG, encryption: 'e2e', e2ePassphrase: 'x' });
    expect(summary.cloudSearchAvailable).toBe(false);
    expect(summary.endToEnd).toContain('provider sees ciphertext only');
    expect(summary.warnings.join(' ')).toContain('cloud-side full-text/semantic search is disabled');
  });
});
