import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGithubAuth } from './githubAuth';

const { cli, spawn } = vi.hoisted(() => ({ cli: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(function () {}, { [promisify.custom]: cli }), spawn };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conecode-gh-'));
  cli.mockReset().mockImplementation(async (_command: string, args: string[]) => ({
    stdout: args[0] === '--version' ? 'gh version 2.102.0' : 'gho_local_only_test_credential\n',
  }));
  spawn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { force: true, recursive: true });
});

function setup() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
  });
  const openExternal = vi.fn(async () => {});
  const auth = createGithubAuth({
    env: () => ({ PATH: '/usr/bin', GH_TOKEN: 'unrelated-automation-token', GH_FORCE_TTY: '1' }),
    configDir: () => dir,
    openExternal,
  });
  spawn.mockReturnValue(child);
  const output = (value: string) => child.stderr.emit('data', Buffer.from(value));
  return { auth, child, openExternal, output };
}

describe('GitHub account connection', () => {
  it('opens only the GitHub verification URL and pins the credential to the authorized account', async () => {
    const { auth, child, openExternal, output } = setup();

    await expect(auth.status()).resolves.toEqual({ state: 'signed-out' });
    expect(auth.login()).toEqual({ state: 'pending' });
    expect(spawn).toHaveBeenCalledWith('gh', ['auth', 'login', '--web', '--hostname', 'github.com'], expect.objectContaining({
      stdio: ['ignore', 'pipe', 'pipe'],
      env: expect.objectContaining({ GH_PROMPT_DISABLED: '1', PATH: '/usr/bin' }),
    }));
    const env = spawn.mock.calls[0][2].env;
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('GH_FORCE_TTY');

    output('! First copy your one-time code: WXYZ-');
    output('1234\nOpen this URL to continue in your web browser: https://untrusted.example/debug\n');
    output('✓ Authentication complete.\n');
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/login/device');
    await expect(auth.status()).resolves.toEqual({ state: 'pending', deviceCode: 'WXYZ-1234' });

    output('✓ Logged in as Alice\n');
    child.emit('close', 0);
    await expect(auth.status()).resolves.toEqual({ state: 'signed-in', login: 'Alice' });
    await expect(auth.token('alice')).resolves.toBe('gho_local_only_test_credential');
    expect(cli).toHaveBeenLastCalledWith('gh', ['auth', 'token', '--hostname', 'github.com', '--user', 'Alice'], expect.anything());
    await expect(auth.token('someone-else')).rejects.toThrow('account changed');
    expect(readFileSync(join(dir, 'account.json'), 'utf8')).toBe('{"login":"Alice"}');
  });

  it('disconnects ConeCode without logging the CLI account out', async () => {
    const { auth, child, output } = setup();
    auth.login();
    output('✓ Logged in as Alice\n');
    child.emit('close', 0);

    await expect(auth.logout()).resolves.toEqual({ state: 'signed-out' });
    await expect(auth.token()).resolves.toBe('');
    expect(cli.mock.calls.every(([, args]) => !args.includes('logout'))).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('cancels the subprocess and ignores its late output', async () => {
    const { auth, child, openExternal, output } = setup();
    auth.login();
    await expect(auth.cancel()).resolves.toEqual({ state: 'signed-out' });
    expect(child.kill).toHaveBeenCalledOnce();

    output('! First copy your one-time code: WXYZ-1234\n✓ Logged in as Alice\n');
    child.emit('close', 0);
    expect(openExternal).not.toHaveBeenCalled();
    await expect(auth.token()).resolves.toBe('');
  });

  it('expires an uncompleted sign-in', async () => {
    vi.useFakeTimers();
    const { auth, child } = setup();
    auth.login();
    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(child.kill).toHaveBeenCalledOnce();
    await expect(auth.status()).resolves.toEqual({ state: 'error', error: 'timed-out' });
  });

  it('reports a missing GitHub CLI without exposing subprocess diagnostics', async () => {
    const { auth } = setup();
    cli.mockRejectedValueOnce(Object.assign(new Error('private details'), { code: 'ENOENT' }));
    await expect(auth.status()).resolves.toEqual({ state: 'unavailable' });
    cli.mockRejectedValueOnce(new Error('private details'));
    await expect(auth.status()).resolves.toEqual({ state: 'error', error: 'status-failed' });
  });
});
