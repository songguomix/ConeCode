import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { previewManager } from './devserver';

// Exercises the manager for real: it serves a folder over a real socket, spawns
// a real dev server, and kills it again. The point is the things unit tests
// can't see — that the port opens, that traversal is refused end to end, that
// the watcher fires, and that stopping actually frees the port and the process.

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-preview-e2e-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(async () => {
  await previewManager.stop();
});

function makeStaticSite(name: string): string {
  const site = path.join(tmp, name);
  fs.mkdirSync(path.join(site, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>generated page</h1>');
  fs.writeFileSync(path.join(site, 'assets', 'app.css'), 'body{color:red}');
  return site;
}

describe('static previews', () => {
  it('serves the folder over loopback', async () => {
    const site = makeStaticSite('serve');
    const status = await previewManager.start({ cwd: site });

    expect(status.state).toBe('running');
    expect(status.url).toMatch(/^http:\/\/localhost:\d+\//);

    const res = await fetch(status.url!);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('generated page');
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    // Reloading must show the newest bytes, so nothing may be cached.
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('serves nested assets with their own content type', async () => {
    const site = makeStaticSite('assets');
    const { url } = await previewManager.start({ cwd: site });

    const res = await fetch(new URL('/assets/app.css', url!));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/css/);
  });

  it('will not serve a file above the folder it was given', async () => {
    const site = makeStaticSite('contained');
    fs.writeFileSync(path.join(tmp, 'SECRET.txt'), 'do not serve me');
    const { url } = await previewManager.start({ cwd: site });

    // fetch() normalises "..", so ask the server the raw way a page could.
    const base = new URL(url!);
    const res = await fetch(`http://${base.host}/../SECRET.txt`);
    expect(await res.text()).not.toContain('do not serve me');
  });

  it('hands unknown paths to index.html so client routes resolve', async () => {
    const site = makeStaticSite('spa');
    const { url } = await previewManager.start({ cwd: site });

    const res = await fetch(new URL('/some/client/route', url!));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('generated page');
  });

  it('404s a missing asset', async () => {
    const site = makeStaticSite('missing');
    const { url } = await previewManager.start({ cwd: site });

    expect((await fetch(new URL('/nope.png', url!))).status).toBe(404);
  });

  it('asks the panel to reload after an edit, and serves the new bytes', async () => {
    const site = makeStaticSite('watch');
    const { url } = await previewManager.start({ cwd: site });

    const reloaded = new Promise<void>((resolve) => previewManager.once('reload', () => resolve()));
    fs.writeFileSync(path.join(site, 'index.html'), '<h1>edited</h1>');

    await Promise.race([reloaded, new Promise((_, reject) => setTimeout(() => reject(new Error('no reload')), 4000))]);
    expect(await (await fetch(url!)).text()).toContain('edited');
  });

  it('frees the port when stopped', async () => {
    const site = makeStaticSite('stop');
    const { url } = await previewManager.start({ cwd: site });
    const dead = url!;

    await previewManager.stop();
    expect(previewManager.getStatus().state).toBe('idle');
    await expect(fetch(dead)).rejects.toThrow();
  });
});

describe('script previews', () => {
  // A stand-in dev server: prints its address the coloured way vite does, then
  // keeps listening until it's killed.
  function makeDevServerProject(name: string): string {
    const app = path.join(tmp, name);
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name, scripts: { dev: 'node server.js' } }));
    fs.writeFileSync(path.join(app, 'server.js'), [
      "const http = require('http');",
      "const s = http.createServer((_, res) => res.end('<h1>dev server</h1>'));",
      "s.listen(0, '127.0.0.1', () => {",
      "  console.log('  \\x1b[32m➜\\x1b[39m  Local:   http://localhost:' + s.address().port + '/');",
      '});',
    ].join('\n'));
    return app;
  }

  async function waitForUrl(timeoutMs = 20000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { url, state, error } = previewManager.getStatus();
      if (url) return url;
      if (state === 'error') throw new Error(`preview failed: ${error}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('dev server never announced a url');
  }

  it('runs the dev script and finds the url it prints', async () => {
    const app = makeDevServerProject('devserver');
    const started = await previewManager.start({ cwd: app });
    expect(started.plan?.command).toBe('npm run dev');

    const url = await waitForUrl();
    expect(url).toMatch(/^http:\/\/localhost:\d+\//);
    expect(await (await fetch(url)).text()).toContain('dev server');
  }, 30000);

  it('kills the whole process group on stop', async () => {
    const app = makeDevServerProject('kill');
    await previewManager.start({ cwd: app });
    await waitForUrl();
    const pid = previewManager.getStatus().pid!;
    expect(pid).toBeGreaterThan(0);

    await previewManager.stop();
    await new Promise((r) => setTimeout(r, 1200));

    // Signal 0 only probes for existence; it throws once the group is gone.
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30000);

  it('reports a project it cannot run rather than guessing', async () => {
    const app = path.join(tmp, 'backend-only');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'main.py'), 'print("hi")');

    const status = await previewManager.start({ cwd: app });
    expect(status.state).toBe('error');
    expect(status.error).toBe('notDetected');
  });

  it('runs a command the user typed instead of the detected one', async () => {
    const app = makeDevServerProject('custom');
    const status = await previewManager.start({ cwd: app, command: 'node server.js' });
    expect(status.plan).toMatchObject({ mode: 'command', command: 'node server.js' });
    expect(await waitForUrl()).toMatch(/^http:\/\/localhost:\d+\//);
  }, 30000);
});
