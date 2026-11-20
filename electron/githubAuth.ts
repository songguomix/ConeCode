import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GithubAccountStatus } from '../src/types/github.types';

const run = promisify(execFile);
const HOST = 'github.com';
const DEVICE_URL = `https://${HOST}/login/device`;
const SIGN_IN_TIMEOUT = 15 * 60 * 1000;
const LOGIN_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

interface GithubAuthOptions {
  env: () => NodeJS.ProcessEnv;
  configDir: () => string;
  openExternal: (url: string) => Promise<void>;
}

export function createGithubAuth({ env, configDir, openExternal }: GithubAuthOptions) {
  const accountPath = () => join(configDir(), 'account.json');
  let attempt: { deviceCode?: string; cancel: () => void } | null = null;
  let lastError: GithubAccountStatus['error'];
  let revision = 0;

  function cliEnv(): NodeJS.ProcessEnv {
    const next: NodeJS.ProcessEnv = { ...env(), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0' };
    // Sign-in uses the named CLI account, independent of automation tokens.
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
      'GH_DEBUG', 'GH_FORCE_TTY', 'CLICOLOR_FORCE']) {
      delete next[name];
    }
    return next;
  }

  function account(): string | undefined {
    try {
      const login = JSON.parse(readFileSync(accountPath(), 'utf8')).login;
      return typeof login === 'string' && LOGIN_NAME.test(login) ? login : undefined;
    } catch {
      return undefined;
    }
  }

  async function cli(args: string[]) {
    const { stdout } = await run('gh', args, { env: cliEnv(), timeout: 10000, windowsHide: true, maxBuffer: 65536 });
    return stdout.trim();
  }

  function readToken(login: string) {
    return cli(['auth', 'token', '--hostname', HOST, '--user', login]);
  }

  async function status(): Promise<GithubAccountStatus> {
    if (attempt) return { state: 'pending', deviceCode: attempt.deviceCode };
    const currentRevision = revision;
    const login = account();
    let result: GithubAccountStatus;
    try {
      const token = login ? await readToken(login) : '';
      if (!login) await cli(['--version']);
      if (lastError) result = { state: 'error', error: lastError };
      else result = login && token ? { state: 'signed-in', login } : { state: 'signed-out' };
    } catch (error) {
      result = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { state: 'unavailable' }
        : { state: 'error', error: lastError ?? 'status-failed' };
    }
    return currentRevision === revision ? result : status();
  }

  function login(): GithubAccountStatus {
    if (attempt) return { state: 'pending', deviceCode: attempt.deviceCode };
    lastError = undefined;
    revision++;
    // With prompts disabled, gh prints the device code and verification URL.
    // ConeCode handles opening the browser. No credential helper is configured.
    const child = spawn('gh', ['auth', 'login', '--web', '--hostname', HOST], {
      env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const current = {
      deviceCode: undefined as string | undefined,
      cancel: () => { finish(); child.kill(); },
    };
    attempt = current;
    const timeout = setTimeout(() => finish('timed-out'), SIGN_IN_TIMEOUT);
    timeout.unref();
    let output = '';

    function finish(error?: GithubAccountStatus['error']) {
      if (attempt !== current) return;
      attempt = null;
      clearTimeout(timeout);
      lastError = error;
      if (error === 'timed-out') child.kill();
    }

    function receive(data: Buffer) {
      if (attempt !== current) return;
      output = (output + data.toString()).slice(-4096);
      if (current.deviceCode) return;
      const deviceCode = /\bone-time code[:(\s]+([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(output)?.[1];
      if (deviceCode) {
        current.deviceCode = deviceCode;
        void openExternal(DEVICE_URL).catch(() => {});
      }
    }

    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', () => finish('login-failed'));
    child.once('close', (code) => {
      if (attempt !== current) return;
      const username = /\bLogged in as\s+([a-z0-9][a-z0-9_-]{0,63})(?=\s|$)/i.exec(output)?.[1];
      if (code !== 0 || !username) {
        finish('login-failed');
        return;
      }
      try {
        mkdirSync(configDir(), { recursive: true, mode: 0o700 });
        const file = accountPath();
        const temporary = `${file}.tmp`;
        writeFileSync(temporary, JSON.stringify({ login: username }), { mode: 0o600 });
        renameSync(temporary, file);
        finish();
      } catch {
        finish('login-failed');
      }
    });

    return { state: 'pending' };
  }

  function dispose() {
    revision++;
    attempt?.cancel();
  }

  async function cancel() {
    dispose();
    return status();
  }

  async function logout(): Promise<GithubAccountStatus> {
    dispose();
    try {
      // The CLI holds the credential. Disconnect ConeCode independently.
      rmSync(accountPath(), { force: true });
      lastError = undefined;
    } catch {
      lastError = 'logout-failed';
    }
    return status();
  }

  async function token(expectedLogin?: string): Promise<string> {
    const login = account();
    if (expectedLogin !== undefined && login?.toLowerCase() !== expectedLogin.toLowerCase()) {
      throw new Error('The connected GitHub account changed. Confirm the operation again.');
    }
    if (!login) return '';
    const credential = await readToken(login).catch(() => '');
    if (!credential || /\s/.test(credential)) throw new Error('The GitHub CLI credential is unavailable. Reconnect the GitHub account.');
    if (account() !== login) throw new Error('The connected GitHub account changed. Confirm the operation again.');
    return credential;
  }

  return { status, login, cancel, logout, token, dispose };
}
