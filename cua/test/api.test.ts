import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startFixtureServer, type FixtureServer } from '../src/fixtures/web-app.js';
import { RuntimeService } from '../src/service/runtime-service.js';
import { CuaHttpServer, type HttpServerInfo } from '../src/service/http-server.js';
import { CuaClient } from '../src/sdk.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { request } from 'node:http';

const execFileAsync = promisify(execFile);
let fixture: FixtureServer;
let dir: string;
let service: RuntimeService;
let http: CuaHttpServer;
let info: HttpServerInfo;
let taskId: string;

beforeAll(async () => {
  fixture = await startFixtureServer();
  await fixture.reset();
  dir = await mkdtemp(join(tmpdir(), 'cua-api-'));
  service = new RuntimeService({ dataDir: dir, recoverOnStart: false, monitorIntervalMs: 0 });
  await service.start();
  http = new CuaHttpServer(service, { port: 0, token: 'api-test-token', ssePollMs: 100 });
  info = await http.start();
  const client = new CuaClient({ baseUrl: info.url, token: info.token });
  const task = await client.createTask({
    goal: 'API task',
    acceptance: [{ kind: 'record_field', url: `${fixture.url}/api/projects/1`, path: ['name'], equals: 'ApiDemo' }],
    environment: { kind: 'browser', startUrl: fixture.url, headless: true, profile: 'default' },
    model: { provider: 'scripted', model: 'scripted-deterministic' },
    script: [
      { kind: 'tool', name: 'browser_fill', arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'ApiDemo' } },
      { kind: 'tool', name: 'browser_click', arguments: { target: { role: 'button', name: 'Save' }, expected: [{ kind: 'record_field', url: `${fixture.url}/api/projects/1`, path: ['name'], equals: 'ApiDemo', withinMs: 5_000 }] } },
      { kind: 'tool', name: 'finish', arguments: { summary: 'done' } },
    ],
  } as any);
  taskId = task.id;
  const final = await client.waitForTask(task.id, 60_000);
  expect(final.status).toBe('succeeded');
});
afterAll(async () => {
  await http?.close();
  await service?.close();
  await fixture?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('HTTP API, SDK, CLI and MCP surfaces', () => {
  it('enforces bearer authentication and writes a 0600 token file', async () => {
    const unauthorized = await fetch(`${info.url}/api/tasks`);
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(`${info.url}/api/tasks`, { headers: { authorization: `Bearer ${info.token}` } });
    expect(authorized.status).toBe(200);
    const mode = (await stat(info.tokenFile)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('serves the React console with a locally injected token', async () => {
    const response = await fetch(info.url);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('__CUA_TOKEN__');
    expect(html).toContain('assets/');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('rejects DNS rebinding hosts, cross-origin requests, and non-loopback binding', async () => {
    const rebound = await new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
      const req = request(info.url, { headers: { host: `attacker.example:${info.port}` } }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolveResponse({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(rebound.status).toBe(403);
    expect(rebound.body).not.toContain('__CUA_TOKEN__');
    const crossOrigin = await fetch(`${info.url}/api/tasks`, { headers: { origin: 'https://attacker.example', authorization: `Bearer ${info.token}` } });
    expect(crossOrigin.status).toBe(403);
    const remote = new CuaHttpServer(service, { host: '0.0.0.0', port: 0 });
    await expect(remote.start()).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
  });

  it('allows an explicitly configured container bind while advertising loopback', async () => {
    const container = new CuaHttpServer(service, { host: '0.0.0.0', port: 0, token: 'container-test', tokenFile: join(dir, 'container-token'), allowNonLoopbackBind: true });
    try {
      const address = await container.start();
      expect(address.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect((await fetch(address.url)).status).toBe(200);
    } finally {
      await container.close();
    }
  });

  it('returns protocol errors for invalid request bodies and cursors', async () => {
    for (const path of ['/api/tasks?limit=-1', '/api/tasks?limit=abc', '/api/events?since=NaN', `/api/tasks/${taskId}/events?since=-2`]) {
      const response = await fetch(`${info.url}${path}`, { headers: { authorization: `Bearer ${info.token}` } });
      expect(response.status).toBe(400);
      expect((await response.json() as any).error.code).toBe('PROTOCOL_INVALID');
    }
    for (const [path, body] of [['/api/tasks', {}], [`/api/tasks/${taskId}/control`, null], [`/api/tasks/${taskId}/control`, { action: 'invalid' }], [`/api/tasks/${taskId}/input`, {}]] as const) {
      const response = await fetch(`${info.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      expect((await response.json() as any).error.code).toBe('PROTOCOL_INVALID');
    }
    const absent = await fetch(`${info.url}/api/tasks/absent/events?stream=1`, { headers: { authorization: `Bearer ${info.token}` } });
    expect(absent.status).toBe(404);
  });

  it('repairs existing token-file permissions and safely embeds custom tokens', async () => {
    const tokenFile = join(dir, 'custom-token');
    await writeFile(tokenFile, 'old', { mode: 0o644 });
    const token = '</script><script>window.injected=true</script>';
    const other = new CuaHttpServer(service, { port: 0, token, tokenFile });
    try {
      const address = await other.start();
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
      const html = await (await fetch(address.url)).text();
      expect(html).not.toContain(token);
      expect(html).toContain('\\u003c/script>');
    } finally {
      await other.close();
    }
  });

  it('resumes SSE after Last-Event-ID without replaying already read events', async () => {
    const all = service.getEvents(taskId);
    const since = all[0]!.seq;
    const abort = new AbortController();
    const response = await fetch(`${info.url}/api/tasks/${taskId}/events?stream=1`, {
      headers: { authorization: `Bearer ${info.token}`, 'Last-Event-ID': String(since) }, signal: abort.signal,
    });
    const reader = response.body!.getReader();
    let text = '';
    try {
      while (!text.includes('data:')) {
        const result = await reader.read();
        if (result.done) throw new Error('SSE ended before first event');
        text += new TextDecoder().decode(result.value);
      }
      const event = JSON.parse(text.split('\n').find((line) => line.startsWith('data:'))!.slice(5));
      expect(event.seq).toBe(all[1]!.seq);
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it('reads the same task through the SDK, including evidence and live events', async () => {
    const client = new CuaClient({ baseUrl: info.url, token: info.token });
    const details = await client.getTask(taskId);
    expect(details.task.status).toBe('succeeded');
    expect(details.actions.length).toBe(2);
    expect(details.verifications.some((v) => v.verdict === 'pass')).toBe(true);
    expect(details.latestObservation?.screenshot?.artifactId).toBeTruthy();
    const artifact = await fetch(`${info.url}/api/artifacts/${details.latestObservation!.screenshot!.artifactId}`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get('content-type')).toBe('image/png');
    const events = await client.events(taskId);
    expect(events.some((e) => e.type === 'task.finished')).toBe(true);
    const streamed: string[] = [];
    for await (const event of client.stream(taskId, 0)) {
      streamed.push(event.type);
      if (event.type === 'task.finished') break;
    }
    expect(streamed).toContain('task.finished');
  });

  it('deletes an explicitly named workflow through the same SDK/service without deleting evidence', async () => {
    const client = new CuaClient({ baseUrl: info.url, token: info.token });
    const name = 'explicit/delete workflow';
    service.store.upsertWorkflow(name, { goal: 'Delete this memory only', steps: [] });
    expect((await client.listWorkflows()).some((workflow) => workflow.name === name)).toBe(true);
    expect(await client.deleteWorkflow(name)).toBe(true);
    expect(await client.deleteWorkflow(name)).toBe(false);
    expect((await client.listWorkflows()).some((workflow) => workflow.name === name)).toBe(false);
    expect((await client.getTask(taskId)).task.status).toBe('succeeded');
    expect((await client.events(taskId)).length).toBeGreaterThan(0);
  });

  it('CLI reads the same service state', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', resolve('src/cli.ts'), 'task', 'list', '--api', info.url, '--token', info.token],
      { timeout: 30_000 },
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.some((task: any) => task.id === taskId && task.status === 'succeeded')).toBe(true);
  });

  it('MCP exposes versioned tools backed by the same service', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('src/mcp-server.ts')],
      env: { ...process.env, CUA_API_URL: info.url, CUA_TOKEN: info.token },
      stderr: 'pipe',
    });
    const mcp = new Client({ name: 'cua-test', version: '0.1.0' });
    await mcp.connect(transport);
    try {
      const tools = await mcp.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['cua_create_task', 'cua_get_task', 'cua_control_task', 'cua_get_events']));
      const listed = await mcp.callTool({ name: 'cua_list_tasks', arguments: { schemaVersion: 1, limit: 10 } });
      const payload = JSON.parse((listed.content as any)[0].text);
      expect(payload.schemaVersion).toBe(1);
      expect(payload.tasks.some((task: any) => task.id === taskId)).toBe(true);
      const fetched = await mcp.callTool({ name: 'cua_get_task', arguments: { schemaVersion: 1, taskId } });
      const detail = JSON.parse((fetched.content as any)[0].text);
      expect(detail.task.task.status).toBe('succeeded');
      const paused = await mcp.callTool({ name: 'cua_control_task', arguments: { schemaVersion: 1, taskId, action: 'pause' } });
      expect(paused.isError).toBe(true); // task is already terminal; the service reports a conflict rather than faking control
    } finally {
      await mcp.close();
    }
  });

  it('keeps console selection consistent when an older task response arrives late', async () => {
    const task = await service.createTask({
      goal: 'Second console task',
      acceptance: [{ kind: 'record_field', url: `${fixture.url}/api/projects/1`, path: ['name'], equals: 'ApiDemo' }],
      environment: { kind: 'browser', startUrl: fixture.url, headless: true },
      model: { provider: 'scripted' },
      script: [{ kind: 'tool', name: 'finish', arguments: { summary: 'Already matches' } }],
    });
    expect((await service.awaitTask(task.id)).status).toBe('succeeded');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      let release: (() => void) | undefined;
      let requested: (() => void) | undefined;
      const reached = new Promise<void>((resolve) => { requested = resolve; });
      const delayed = new Promise<void>((resolve) => { release = resolve; });
      await page.route(`${info.url}/api/tasks/${taskId}`, async (route) => {
        requested!();
        await delayed;
        await route.continue();
      });
      await page.goto(info.url);
      await page.locator('.task-row').filter({ hasText: 'API task' }).click();
      await reached;
      await page.locator('.task-row').filter({ hasText: 'Second console task' }).click();
      await expect.poll(() => page.locator('.detail h2').textContent()).toBe('Second console task');
      release!();
      await page.waitForResponse(`${info.url}/api/tasks/${taskId}`);
      await expect.poll(() => page.locator('.detail .kicker').textContent()).toBe(task.id);
      expect(await page.locator('.detail h2').textContent()).toBe('Second console task');
    } finally {
      await browser.close();
    }
  });
});
