import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { MarketVersion } from '../../src/core/dsh-market/types';
import { NpmRunner, verifyArchiveIntegrity } from './installer';
import { buildInstallSpec } from './security';
import { NPM_INSTALL_TIMEOUT_MS } from './constants';

const run = promisify(execFile);

function locateDsh(): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const override = env.CONECODE_DSH?.trim();
  const isFile = (file: string) => {
    try { return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false; } catch { return false; }
  };
  const commandAt = (file: string) => {
    if (!isFile(file)) return null;
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) {
      // Use npm's JS entry rather than interpolating package arguments into cmd.exe.
      const cli = path.join(path.dirname(file), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (!isFile(cli)) return null;
      return { executable: process.execPath, args: ['--expose-internals', cli], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
    }
    return { executable: file, args: [], env: { ...env, PATH: [path.dirname(file), env.PATH].filter(Boolean).join(path.delimiter) } };
  };
  if (override) {
    const command = path.isAbsolute(override) && commandAt(override);
    if (!command) throw new Error('CONECODE_DSH must point to an absolute dsh executable.');
    return command;
  }
  if (process.platform === 'win32') {
    for (const dir of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles].filter(Boolean) as string[]) {
      const executable = path.join(dir, 'DeepSeek Harness', 'DeepSeek Harness.exe');
      const cli = path.join(path.dirname(executable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
      if (isFile(executable) && isFile(cli)) return { executable, args: ['--expose-internals', cli], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
    }
  }
  const dirs = [...(env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
  if (process.platform === 'darwin') {
    for (const apps of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      dirs.push(path.join(apps, 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin'));
    }
  }
  for (const dir of dirs.filter((value) => path.isAbsolute(value))) {
    const executable = path.join(dir, process.platform === 'win32' ? 'dsh.exe' : 'dsh');
    const command = commandAt(executable) || (process.platform === 'win32' && commandAt(path.join(dir, 'dsh.cmd')));
    if (command) return command;
  }
  throw new Error('Install DeepSeek Harness Desktop or put its dsh executable on PATH (or set CONECODE_DSH).');
}

/** The launch URL carries a process token. Only Electron main opens it, and only on loopback. */
export function dshWebUrl(line: string): string | null {
  const match = /^dsh web:\s+(http:\/\/\S+)\s*$/.exec(line.trim());
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    return url.hostname === '127.0.0.1' && url.port && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function diagnostic(message: string): string {
  return message.replace(/https?:\/\/\S+/gi, '[URL]').slice(-2400);
}

export class OfficialDshWeb {
  private sessions = new Map<string, { process: ChildProcess; url: Promise<string> }>();
  private operations = new Set<string>();
  private shutdown = new AbortController();
  private npm: NpmRunner;

  constructor(cacheDir: string) { this.npm = new NpmRunner(cacheDir); }

  async open(home: string, selection?: { name: string; version: MarketVersion }): Promise<string> {
    if (this.shutdown.signal.aborted) throw new Error('DSH Web is shutting down');
    if (this.operations.has(home)) throw new Error('A DSH Web operation is already in progress for this profile');
    this.operations.add(home);
    try {
      const cli = locateDsh();
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const env = { ...cli.env, DSH_HOME: home };
      if (selection) {
        const archive = await this.archive(home, selection.name, selection.version);
        try {
          // The official manager checks the installed runtime range and owns its profile and lockfile.
          await run(cli.executable, [...cli.args, 'plugin', '--profile', 'web', 'add', '--ignore-scripts', archive], {
            cwd: home, env, signal: this.shutdown.signal, timeout: NPM_INSTALL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
          });
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          throw new Error(`DSH Web plugin installation failed: ${diagnostic([failure.stdout, failure.stderr].filter(Boolean).join('\n') || failure.message)}`);
        }
      }
      const existing = this.sessions.get(home);
      if (existing) return await existing.url;
      const child = spawn(cli.executable, [...cli.args, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
        cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      const url = new Promise<string>((resolve, reject) => {
        let tail = '';
        const timer = setTimeout(() => { reject(new Error(`DSH Web startup timed out. ${diagnostic(tail)}`)); child.kill(); }, 90_000);
        const stdout = createInterface({ input: child.stdout });
        stdout.on('line', (line) => {
          const address = dshWebUrl(line);
          if (address) { clearTimeout(timer); resolve(address); }
        });
        child.stderr.on('data', (chunk) => { tail = (tail + chunk).slice(-4096); });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (this.sessions.get(home)?.process === child) this.sessions.delete(home);
          reject(new Error(`DSH Web exited (${code}). ${diagnostic(tail)}`));
        });
      });
      this.sessions.set(home, { process: child, url });
      return await url;
    } finally { this.operations.delete(home); }
  }

  private async archive(home: string, name: string, version: MarketVersion): Promise<string> {
    if (version.source.type !== 'npm') throw new Error('Select an npm version or import this source in the DSH Web plugin manager.');
    const { spec, registry } = buildInstallSpec(name, version.version, version.source);
    const root = path.join(home, 'archives');
    fs.mkdirSync(root, { recursive: true });
    const staging = fs.mkdtempSync(path.join(root, 'pack-'));
    try {
      const result = await this.npm.run(['pack', '--ignore-scripts', '--json', ...(registry ? ['--registry', registry] : []), '--', spec], staging, {
        timeoutMs: NPM_INSTALL_TIMEOUT_MS, signal: this.shutdown.signal,
      });
      if (result.code !== 0) throw new Error(`npm pack ${spec} failed. ${diagnostic(result.stderr)}`);
      const [packed] = JSON.parse(result.stdout);
      if (packed?.name !== name || packed.version !== version.version) throw new Error(`Unexpected package in archive for ${spec}`);
      const [filename] = fs.readdirSync(staging).filter((file) => file.endsWith('.tgz'));
      if (!filename || filename !== packed.filename) throw new Error(`npm did not produce the archive for ${spec}`);
      const archive = path.join(staging, filename);
      const integrity = await verifyArchiveIntegrity(archive, version.integrity ?? packed.integrity, spec);
      // pnpm keeps a file dependency in its lockfile. Keep the exact verified archive for repair/restart.
      const dir = path.join(root, createHash('sha256').update(integrity).digest('hex'));
      fs.mkdirSync(dir, { recursive: true });
      const destination = path.join(dir, filename);
      fs.renameSync(archive, destination);
      return destination;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }

  stop(): void {
    this.shutdown.abort();
    this.npm.killAll();
    for (const session of this.sessions.values()) session.process.kill();
  }
}
