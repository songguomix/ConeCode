import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Verifier, assertPathWithin } from '../src/agent/verifier.js';
import { TaskSchema, DEFAULT_BUDGET, nowIso, type Condition } from '../src/protocol/schemas.js';
import { newId } from '../src/protocol/ids.js';

function task(origins: string[] = [], roots: string[] = []) {
  return TaskSchema.parse({
    schemaVersion: 1, id: newId('task'), runId: newId('run'), goal: 'Verify safely',
    constraints: [], acceptance: [{ kind: 'custom', description: 'fixture' }], acceptanceSource: 'user',
    authorization: { allowedOrigins: origins, allowedFileRoots: roots }, budgets: DEFAULT_BUDGET,
    environment: { kind: 'browser' }, status: 'verifying', createdAt: nowIso(), updatedAt: nowIso(), version: 0,
  });
}

describe('Verifier read-only authorization boundary', () => {
  it('never sends verifier POST requests, including recovery, or requests to unauthorized origins', async () => {
    const calls: string[] = [];
    const server = createServer((req, res) => { calls.push(req.method!); res.setHeader('content-type', 'application/json'); res.end('{"name":"Demo"}'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const verifier = new Verifier();
    try {
      const cases: Condition[] = [
        { kind: 'http_status', url: origin, method: 'POST', body: { write: true }, status: 200 },
        { kind: 'record_field', url: origin, method: 'POST', path: ['name'], equals: 'Demo' },
      ];
      for (const condition of cases) {
        expect((await verifier.verify({ task: task([origin]), criteria: [condition], scope: 'recovery' })).verdict).toBe('insufficient_evidence');
      }
      const read: Condition = { kind: 'http_status', url: origin, method: 'GET', status: 200 };
      expect((await verifier.verify({ task: task([]), criteria: [read], scope: 'action' })).verdict).toBe('insufficient_evidence');
      expect(calls).toEqual([]);
      expect((await verifier.verify({ task: task([origin]), criteria: [read], scope: 'task' })).verdict).toBe('pass');
      expect(calls).toEqual(['GET']);
      const expired = task([origin]);
      expired.authorization.expiresAt = new Date(Date.now() - 1000).toISOString();
      expect((await verifier.verify({ task: expired, criteria: [read], scope: 'task' })).verdict).toBe('insufficient_evidence');
      expect(calls).toEqual(['GET']);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it('does not follow redirects out of the authorized origin', async () => {
    let escaped = 0;
    const outside = createServer((_req, res) => { escaped++; res.end('outside'); });
    await new Promise<void>((resolve) => outside.listen(0, '127.0.0.1', resolve));
    const forbidden = `http://127.0.0.1:${(outside.address() as any).port}`;
    const server = createServer((_req, res) => { res.writeHead(302, { location: forbidden }); res.end(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const result = await new Verifier().verify({ task: task([origin]), criteria: [{ kind: 'http_status', url: origin, method: 'GET', status: 200 }], scope: 'recovery' });
      expect(result.verdict).toBe('unknown');
      expect(escaped).toBe(0);
    } finally { await Promise.all([new Promise<void>((r) => server.close(() => r())), new Promise<void>((r) => outside.close(() => r()))]); }
  });

  it('requires explicit file roots and rejects traversal and symlink escapes for existing and new files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cua-verifier-'));
    const allowed = join(dir, 'allowed');
    const outside = join(dir, 'outside');
    await mkdir(allowed); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(allowed, 'link'));
    try {
      expect(() => assertPathWithin(join(outside, 'secret.txt'), [])).toThrow(/explicit/);
      expect(() => assertPathWithin(`${allowed}/../outside/secret.txt`, [allowed])).toThrow(/outside/);
      expect(() => assertPathWithin(join(allowed, 'link', 'new.txt'), [allowed])).toThrow(/outside/);
      expect(() => assertPathWithin(join(allowed, 'link', 'secret.txt'), [allowed])).toThrow(/outside/);
      const verdict = await new Verifier().verify({ task: task([], [allowed]), criteria: [{ kind: 'file_content', path: join(allowed, 'link', 'secret.txt'), equals: 'secret' }], scope: 'task' });
      expect(verdict.verdict).toBe('insufficient_evidence');
      const newPath = assertPathWithin(join(allowed, 'new.txt'), [allowed]);
      expect(newPath.endsWith('/allowed/new.txt')).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
