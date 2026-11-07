import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SessionStore } from '../src/store/store.js';
import { RuntimeService } from '../src/service/runtime-service.js';
import { TaskSchema, nowIso } from '../src/protocol/schemas.js';
import { newId } from '../src/protocol/ids.js';

it('verifies durable acceptance without loading startup scripts that could resubmit', async () => {
  let pageLoads = 0;
  let submissions = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') { submissions++; response.end('saved'); return; }
    if (request.url === '/record') { response.setHeader('content-type', 'application/json'); response.end('{"name":"Demo"}'); return; }
    pageLoads++;
    response.setHeader('content-type', 'text/html');
    response.end('<script>fetch("/submit",{method:"POST"})</script>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const url = `http://127.0.0.1:${address.port}`;
  const dir = await mkdtemp(join(tmpdir(), 'cua-readonly-recovery-'));
  const task = TaskSchema.parse({
    id: newId('task'), runId: newId('run'), goal: 'Recover the existing Demo record.',
    acceptance: [{ kind: 'record_field', url: `${url}/record`, path: ['name'], equals: 'Demo' }],
    authorization: { allowedOrigins: [url] }, budgets: {}, environment: { kind: 'browser', startUrl: url },
    status: 'executing', createdAt: nowIso(), updatedAt: nowIso(), version: 0,
  });
  const store = new SessionStore(join(dir, 'runtime.db'));
  store.createTask(task);
  store.close();
  const service = new RuntimeService({ dataDir: dir, recoverOnStart: true, monitorIntervalMs: 0 });
  try {
    await service.start();
    expect(service.getTask(task.id).task.status).toBe('succeeded');
    expect(pageLoads).toBe(0);
    expect(submissions).toBe(0);
  } finally {
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
