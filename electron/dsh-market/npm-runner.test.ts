import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NpmRunner } from './installer';

const roots: string[] = [];
function tempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode npm runner '));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const fixture = `
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('10.9.8');
else console.log(JSON.stringify({ args, cache: process.env.npm_config_cache }));
`;

it.skipIf(process.platform === 'win32')('finds a user-local npm outside the desktop PATH and can run it with its Node', async () => {
  const root = tempDir();
  const bin = path.join(root, '.local', 'node', 'bin');
  const staleBin = path.join(root, 'desktop-bin');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(staleBin);
  fs.writeFileSync(path.join(staleBin, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const npm = path.join(bin, 'npm');
  fs.writeFileSync(npm, `#!/usr/bin/env node\n${fixture}`, { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('PATH', staleBin);
  vi.stubEnv('CONECODE_NPM', undefined);

  const runner = new NpmRunner(cache);
  expect(await runner.locate()).toEqual({ path: npm, version: '10.9.8' });
  const args = ['install', 'local plugin & dependencies'];
  const result = await runner.run(args, root);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ args, cache });
  expect(process.env.PATH).toBe(staleBin);
}, 20_000);

it.runIf(process.platform === 'win32')('runs the npm CLI behind npm.cmd without interpreting the arguments in a shell', async () => {
  const root = tempDir();
  const npm = path.join(root, 'npm.cmd');
  const cli = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, fixture);
  fs.writeFileSync(npm, '@exit /b 1\r\n');
  vi.stubEnv('CONECODE_NPM', npm);
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') || 'Path';
  vi.stubEnv(pathKey, path.dirname(process.execPath));

  const runner = new NpmRunner(cache);
  expect(await runner.locate()).toEqual({ path: npm, version: '10.9.8' });
  const args = ['install', 'local plugin & dependencies'];
  const result = await runner.run(args, root);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ args, cache });
}, 20_000);
