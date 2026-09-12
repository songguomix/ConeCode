import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  detectPreview, extractUrl, resolveStaticPath, contentTypeFor,
  runScriptCommand, detectFramework, stripAnsi,
} from './preview';

// Detection reads real directories, so the fixtures are real directories.
let tmp: string;
const projectDir = (name: string) => path.join(tmp, name);

function makeProject(name: string, files: Record<string, string>): string {
  const dir = projectDir(name);
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-preview-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('extractUrl', () => {
  it('reads the address vite prints', () => {
    expect(extractUrl('  ➜  Local:   http://localhost:5173/\n')).toBe('http://localhost:5173/');
  });

  it('sees through ANSI colour codes', () => {
    const line = '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m3000\x1b[22m/\x1b[39m\n';
    expect(extractUrl(stripAnsi(line))).toBe('http://localhost:3000/');
  });

  it('prefers the localhost address over the network one', () => {
    const out = '- Network: http://0.0.0.0:8080\n- Local: http://localhost:8080\n';
    expect(extractUrl(out)).toBe('http://localhost:8080');
  });

  it('rewrites wildcard and loopback hosts to localhost', () => {
    expect(extractUrl('Server running at http://0.0.0.0:4000')).toBe('http://localhost:4000');
    expect(extractUrl('Server running at http://127.0.0.1:4000')).toBe('http://localhost:4000');
  });

  it('falls back to a bare port announcement', () => {
    expect(extractUrl('Server listening on port 3000')).toBe('http://localhost:3000');
    expect(extractUrl('[express] ready — port 8081')).toBe('http://localhost:8081');
  });

  it('drops trailing punctuation', () => {
    expect(extractUrl('Open http://localhost:5173/app.')).toBe('http://localhost:5173/app');
  });

  it('ignores output that says nothing about an address', () => {
    expect(extractUrl('warning: 3 vulnerabilities found\n')).toBeNull();
    expect(extractUrl('compiling src/main.ts…')).toBeNull();
  });

  it('ignores remote URLs — the preview only ever loads this machine', () => {
    expect(extractUrl('docs at https://vitejs.dev/guide/')).toBeNull();
  });
});

describe('resolveStaticPath', () => {
  const root = path.resolve('/srv/site');

  it('maps a normal request under the root', () => {
    expect(resolveStaticPath(root, '/index.html')).toBe(path.join(root, 'index.html'));
    expect(resolveStaticPath(root, '/assets/app.css')).toBe(path.join(root, 'assets', 'app.css'));
  });

  it('allows the root itself', () => {
    expect(resolveStaticPath(root, '/')).toBe(root);
  });

  it('clamps a climb above the root back inside it', () => {
    expect(resolveStaticPath(root, '/../../etc/passwd')).toBe(path.join(root, 'etc', 'passwd'));
    expect(resolveStaticPath(root, '/assets/../../../../etc/passwd')).toBe(path.join(root, 'etc', 'passwd'));
  });

  it('never resolves outside the served folder', () => {
    const attempts = [
      '/../../etc/passwd',
      '/../site-secrets/keys.txt',
      '/./../../root/.ssh/id_rsa',
      '//../../etc/hosts',
      '/assets/../../../../../../../../tmp/x',
    ];
    for (const attempt of attempts) {
      const resolved = resolveStaticPath(root, attempt);
      // Either rejected outright, or landed somewhere under the served folder.
      if (resolved !== null) {
        expect(resolved === root || resolved.startsWith(root + path.sep)).toBe(true);
      }
    }
  });

  it('keeps traversal that stays inside', () => {
    expect(resolveStaticPath(root, '/assets/../index.html')).toBe(path.join(root, 'index.html'));
  });
});

describe('contentTypeFor', () => {
  it('types the things a generated page loads', () => {
    expect(contentTypeFor('/x/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('/x/app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('/x/style.CSS')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('/x/logo.svg')).toBe('image/svg+xml');
  });

  it('falls back to a binary type for anything unknown', () => {
    expect(contentTypeFor('/x/data.bin')).toBe('application/octet-stream');
    expect(contentTypeFor('/x/LICENSE')).toBe('application/octet-stream');
  });
});

describe('runScriptCommand', () => {
  it('uses each package manager\'s own spelling', () => {
    expect(runScriptCommand('npm', 'dev')).toBe('npm run dev');
    expect(runScriptCommand('pnpm', 'dev')).toBe('pnpm run dev');
    expect(runScriptCommand('bun', 'dev')).toBe('bun run dev');
    expect(runScriptCommand('yarn', 'dev')).toBe('yarn dev');
  });
});

describe('detectFramework', () => {
  it('names the framework from its dependencies', () => {
    expect(detectFramework({ dependencies: { next: '14' } })).toBe('Next.js');
    expect(detectFramework({ devDependencies: { vite: '5' } })).toBe('Vite');
    expect(detectFramework({ dependencies: { express: '4' } })).toBe('Node server');
  });

  it('prefers the meta-framework over the bundler it is built on', () => {
    expect(detectFramework({ dependencies: { astro: '4' }, devDependencies: { vite: '5' } })).toBe('Astro');
  });

  it('returns null when nothing is recognisable', () => {
    expect(detectFramework({ dependencies: { lodash: '4' } })).toBeNull();
    expect(detectFramework(null)).toBeNull();
  });
});

describe('detectPreview', () => {
  it('runs the dev script when there is one', () => {
    const dir = makeProject('vite-app', {
      'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '5' } }),
    });
    const plan = detectPreview(dir);
    expect(plan).toMatchObject({ mode: 'script', command: 'npm run dev', script: 'dev', framework: 'Vite' });
  });

  it('picks the package manager from the lockfile', () => {
    const dir = makeProject('pnpm-app', {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 6.0\n',
    });
    expect(detectPreview(dir)).toMatchObject({ packageManager: 'pnpm', command: 'pnpm run dev' });
  });

  it('prefers dev over start', () => {
    const dir = makeProject('both-scripts', {
      'package.json': JSON.stringify({ scripts: { start: 'node server.js', dev: 'nodemon server.js' } }),
    });
    expect(detectPreview(dir)).toMatchObject({ script: 'dev' });
  });

  it('falls back to start when there is no dev script', () => {
    const dir = makeProject('cra-app', {
      'package.json': JSON.stringify({ scripts: { start: 'react-scripts start' }, dependencies: { 'react-scripts': '5' } }),
    });
    expect(detectPreview(dir)).toMatchObject({ script: 'start', command: 'npm run start', framework: 'Create React App' });
  });

  it('serves a plain HTML folder instead of running anything', () => {
    const dir = makeProject('static-site', { 'index.html': '<h1>hi</h1>' });
    const plan = detectPreview(dir);
    expect(plan).toMatchObject({ mode: 'static', command: null, staticEntry: 'index.html' });
    expect(plan?.staticDir).toBe(dir);
  });

  it('finds the entry point one level down', () => {
    const dir = makeProject('static-public', { 'public/index.html': '<h1>hi</h1>' });
    expect(detectPreview(dir)?.staticDir).toBe(path.join(dir, 'public'));
  });

  it('accepts a differently-named page when there is no index.html', () => {
    const dir = makeProject('single-page', { 'report.html': '<h1>report</h1>' });
    expect(detectPreview(dir)).toMatchObject({ mode: 'static', staticEntry: 'report.html' });
  });

  it('prefers a dev script over an index.html the build produced', () => {
    const dir = makeProject('built-app', {
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'dist/index.html': '<h1>stale build</h1>',
    });
    expect(detectPreview(dir)).toMatchObject({ mode: 'script' });
  });

  it('gives up on a project with nothing to show', () => {
    const dir = makeProject('backend-only', { 'main.py': 'print("hi")' });
    expect(detectPreview(dir)).toBeNull();
  });

  it('gives up on a folder that is not there', () => {
    expect(detectPreview(path.join(tmp, 'no-such-folder'))).toBeNull();
  });

  it('survives a malformed package.json', () => {
    const dir = makeProject('broken-pkg', { 'package.json': '{ not json', 'index.html': '<h1>hi</h1>' });
    expect(detectPreview(dir)).toMatchObject({ mode: 'static' });
  });
});
