import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DshMarketService } from './market-service';
import { dshWebUrl } from './official-web';

it('only accepts the official startup line for the requested loopback listener', () => {
  expect(dshWebUrl('dsh web: http://127.0.0.1:42781/?token=example')).toBe('http://127.0.0.1:42781/?token=example');
  expect(dshWebUrl('plugin log http://127.0.0.1:42781/')).toBeNull();
  expect(dshWebUrl('dsh web: http://example.org:42781/')).toBeNull();
});

it.skipIf(process.env.DSH_WEB_E2E !== '1')('installs the catalog theme into official DSH and serves its client', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'conecode-web-test-'));
  const service = new DshMarketService({ rootDir: root, appPath: process.cwd(), versions: { app: 'test', electron: 'test' } });
  try {
    const address = await service.openDshWeb('default', 'dsh-theme', '1.0.1');
    const login = await fetch(address, { redirect: 'manual' });
    expect(login.status).toBe(303);
    const headers = { cookie: login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ') };
    const index = await fetch(new URL('/', address), { headers });
    expect(index.status).toBe(200);
    const html = await index.text();
    const moduleUrl = /"id":"dsh-theme","url":"([^"]+)"/.exec(html)?.[1];
    expect(moduleUrl).toBeTruthy();
    const client = await fetch(new URL(moduleUrl!, address), { headers });
    expect(client.status).toBe(200);
    expect(await client.text()).toContain('dsh-theme-active-style');
    expect(await service.openDshWeb('default')).toBe(address);
  } finally {
    service.web.stop();
    await service.runtime.shutdown();
    await service.state.flush();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 180_000);
