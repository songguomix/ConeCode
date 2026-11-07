import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CuaError } from '../protocol/errors.js';
import type { EvidenceRef } from '../protocol/schemas.js';

/** OS policy kept separate so its file/network boundary is tested without relying on Node permissions. */
export function macSandboxProfile(nodePath: string, childScript: string, scratch: string): string {
  nodePath = realpathSync(nodePath);
  childScript = realpathSync(childScript);
  scratch = realpathSync(scratch);
  return [
    '(version 1)', '(allow default)', '(deny network*)', '(deny file-write*)',
    `(allow file-write* (subpath ${JSON.stringify(scratch)}))`,
    '(deny file-read-data)',
    // Node opens the root directory during startup; literal / does not grant
    // recursive access to home directories or project files.
    '(allow file-read-data (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/dev"))',
    `(allow file-read-data (literal ${JSON.stringify(nodePath)}) (literal ${JSON.stringify(childScript)}) (subpath ${JSON.stringify(scratch)}))`,
    '(deny process-fork)', '(deny process-exec)',
    `(allow process-exec (literal ${JSON.stringify(nodePath)}))`, '',
  ].join('\n');
}

export interface CodeRunResult {
  ok: boolean;
  value?: unknown;
  logs: string[];
  error?: { name: string; message: string; stack?: string };
  durationMs: number;
  timedOut: boolean;
  /** True only when execution stopped and no accepted host UI RPC is still active. */
  stopped: boolean;
  sessionLost: boolean;
  executedActions: EvidenceRef[];
}

export interface CodeUiContext {
  onUi(method: string, args: Record<string, unknown>): Promise<unknown>;
  executed: EvidenceRef[];
}

export interface CodeRuntimeOptions {
  childScript?: string;
  allowUnsandboxed?: boolean;
  maxOutputBytes?: number;
  startupTimeoutMs?: number;
}

interface PendingRun {
  id: string;
  resolve: (result: CodeRunResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  ctx: CodeUiContext;
  startedAt: number;
  timedOut?: boolean;
  accepting: boolean;
  rpcTail: Promise<void>;
  activeRpcs: number;
  cleanup?: () => void;
}

let runSerial = 0;

/**
 * Persistent code session. The child is a separate process, not a Node `vm` in
 * the host. Node vm is a convenience layer, never a security boundary: model
 * code may escape that context into the child. The OS sandbox denies network,
 * unrelated file access and process creation, while Node permissions provide
 * additional restrictions. UI RPCs are the only authorized environment path.
 */
export class CodeRuntime {
  private child?: ChildProcess;
  private scratch?: string;
  private ready = false;
  private lost = false;
  private buffer = '';
  private stderr = '';
  private pendingRun?: PendingRun;
  private starting?: Promise<void>;
  private inFlightUi = 0;
  private readonly childScript: string;

  constructor(private readonly options: CodeRuntimeOptions = {}) {
    this.childScript = options.childScript ?? fileURLToPath(new URL('./code-child.mjs', import.meta.url));
  }

  get isAlive(): boolean {
    return this.ready && !this.lost && !!this.child && !this.child.killed;
  }

  async start(): Promise<void> {
    if (this.ready && !this.lost) return;
    if (this.inFlightUi > 0) throw new CuaError('UNKNOWN_OUTCOME', 'A terminated code session still has an active host UI operation; reconcile it before restarting.');
    if (!this.starting) this.starting = this.startIsolated().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startIsolated(): Promise<void> {
    if (this.scratch) { await rm(this.scratch, { recursive: true, force: true }); this.scratch = undefined; }
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new CuaError('CODE_SANDBOX_UNAVAILABLE', `Code sandbox is not implemented for ${process.platform}.`);
    }
    if (process.platform === 'darwin') {
      if (!existsSync('/usr/bin/sandbox-exec')) {
        if (!this.options.allowUnsandboxed) {
          throw new CuaError('CODE_SANDBOX_UNAVAILABLE', 'sandbox-exec is unavailable; refusing to run model code unsandboxed.');
        }
        await this.spawnChild(process.execPath, [this.childScript]);
      } else {
        this.scratch = await mkdtemp(join(tmpdir(), 'cua-code-'));
        const profile = macSandboxProfile(process.execPath, this.childScript, this.scratch);
        const nodeArgs = [
          '--experimental-permission',
          '--max-old-space-size=256',
          '--no-addons',
          `--allow-fs-read=${this.childScript}`,
          `--allow-fs-read=${this.scratch}`,
          this.childScript,
        ];
        await this.spawnChild('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, ...nodeArgs]);
      }
    } else {
      const bwrap = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].find(existsSync);
      if (!bwrap) {
        if (!this.options.allowUnsandboxed) {
          throw new CuaError('CODE_SANDBOX_UNAVAILABLE', 'bubblewrap is unavailable; refusing to run model code unsandboxed.');
        }
        await this.spawnChild(process.execPath, [this.childScript]);
      } else {
        // Build an isolated root, with read-only system libraries and no host
        // home/workspace mounts. Linux support must be integration-tested on a
        // host with unprivileged user namespaces enabled.
        const mounts = ['/usr', '/lib', '/lib64'].filter(existsSync).flatMap((path) => ['--ro-bind', path, path]);
        await this.spawnChild(bwrap, [
          '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
          ...mounts, '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
          '--dir', '/app', '--ro-bind', this.childScript, '/app/code-child.mjs',
          ...(process.execPath.startsWith('/usr/') ? [] : ['--dir', dirname(process.execPath), '--ro-bind', process.execPath, process.execPath]),
          process.execPath, '--experimental-permission', '--no-addons', '--max-old-space-size=256',
          '--allow-fs-read=/app/code-child.mjs', '--allow-fs-read=/tmp', '/app/code-child.mjs',
        ]);
      }
    }
  }

  private async spawnChild(command: string, args: string[]): Promise<void> {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: this.scratch ?? tmpdir(),
        TMPDIR: this.scratch ?? tmpdir(),
        LANG: 'en_US.UTF-8',
        NODE_NO_WARNINGS: '0',
      },
    });
    this.child = child;
    this.ready = false;
    this.lost = false;
    this.buffer = '';
    this.stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.onData(chunk));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8_000);
    });
    child.on('exit', (code, signal) => {
      this.ready = false;
      this.lost = true;
      const pending = this.pendingRun;
      if (pending) {
        this.pendingRun = undefined;
        clearTimeout(pending.timer);
        pending.cleanup?.();
        pending.accepting = false;
        pending.resolve({
          ok: false,
          logs: [],
          error: pending.timedOut
            ? { name: 'TimeoutError', message: 'Code run exceeded its timeout; the runtime process was terminated.' }
            : { name: 'RuntimeExited', message: `Code runtime exited (code=${code}, signal=${signal}). ${this.stderr.slice(-500)}` },
          durationMs: Date.now() - pending.startedAt,
          timedOut: pending.timedOut ?? false,
          stopped: this.inFlightUi === 0,
          sessionLost: true,
          executedActions: pending.ctx.executed,
        });
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.killTree().catch(() => undefined);
        reject(new CuaError('CODE_SANDBOX_UNAVAILABLE', `Code runtime did not become ready. ${this.stderr.slice(-1_000)}`));
      }, this.options.startupTimeoutMs ?? 8_000);
      const onReady = () => {
        clearTimeout(timer);
        this.ready = true;
        resolve();
      };
      this.readyResolvers.push(onReady);
      child.once('error', (error) => {
        clearTimeout(timer);
        this.readyResolvers = this.readyResolvers.filter((fn) => fn !== onReady);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        if (this.ready) return;
        clearTimeout(timer);
        this.readyResolvers = this.readyResolvers.filter((fn) => fn !== onReady);
        reject(new CuaError('CODE_SANDBOX_UNAVAILABLE', `Code runtime exited before readiness (code=${code}, signal=${signal}). ${this.stderr.slice(-1_000)}`));
      });
    });
  }

  private readyResolvers: Array<() => void> = [];

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > (this.options.maxOutputBytes ?? 1_000_000)) {
      void this.terminate();
      return;
    }
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === 'ready') {
        for (const resolve of this.readyResolvers.splice(0)) resolve();
      } else if (message.type === 'rpc') {
        const pending = this.pendingRun;
        const allowed = ['observe', 'click', 'fill', 'type', 'press', 'scroll', 'screenshot', 'wait'];
        if (!pending || !pending.accepting || message.runId !== pending.id || !allowed.includes(message.method)) {
          this.send({ type: 'rpc-result', id: message.id, ok: false, error: { code: 'CONFLICT', message: 'UI request does not belong to the active code run.' } });
          continue;
        }
        pending.activeRpcs += 1;
        this.inFlightUi += 1;
        pending.rpcTail = pending.rpcTail.then(async () => {
          // A request queued before cancellation must not execute afterwards.
          if (this.pendingRun !== pending || pending.timedOut) return;
          try {
            const result = await pending.ctx.onUi(message.method, message.args ?? {});
            this.send({ type: 'rpc-result', id: message.id, ok: true, result });
          } catch (error: any) {
            this.send({ type: 'rpc-result', id: message.id, ok: false, error: {
              code: error?.code ?? 'DRIVER_ERROR', message: error?.message ?? String(error),
              sideEffectUnknown: Boolean(error?.sideEffectMayHaveHappened),
            } });
          }
        }).finally(() => { pending.activeRpcs -= 1; this.inFlightUi -= 1; });
      } else if (message.type === 'result') {
        const pending = this.pendingRun;
        if (!pending || pending.id !== message.id) continue;
        pending.accepting = false;
        // A code body may omit await. Still serialize and finish all accepted
        // host actions before advertising completion or admitting a new run.
        void pending.rpcTail.then(() => {
          if (this.pendingRun !== pending) return;
          this.pendingRun = undefined;
          clearTimeout(pending.timer);
          pending.cleanup?.();
          pending.resolve({
            ok: Boolean(message.ok), value: message.value,
            logs: Array.isArray(message.logs) ? message.logs.slice(0, 200) : [],
            error: message.error,
            durationMs: Date.now() - pending.startedAt,
            timedOut: false, stopped: true, sessionLost: false,
            executedActions: pending.ctx.executed,
          });
        });
      }
    }
  }

  private send(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || !child.stdin || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async run(
    code: string,
    options: {
      timeoutMs?: number;
      onUi: (method: string, args: Record<string, unknown>) => Promise<unknown>;
      executed?: EvidenceRef[];
      signal?: AbortSignal;
    },
  ): Promise<CodeRunResult> {
    await this.start();
    if (this.pendingRun) throw new CuaError('CONFLICT', 'A code run is already active in this session.');
    const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 5_000, 60_000));
    const id = `run_${Date.now()}_${++runSerial}`;
    const ctx: CodeUiContext = { onUi: options.onUi, executed: options.executed ?? [] };
    if (options.signal?.aborted) throw new CuaError('CANCELLED', 'Code run cancelled before start.');
    return new Promise<CodeRunResult>((resolve, reject) => {
      const timer = setTimeout(async () => {
        const pending = this.pendingRun;
        if (pending?.id === id) pending.timedOut = true;
        const stopped = await this.terminate();
        resolve({
          ok: false,
          logs: [],
          error: { name: 'TimeoutError', message: `Code run exceeded ${timeoutMs}ms; the session was terminated.` },
          durationMs: timeoutMs,
          timedOut: true,
          stopped,
          sessionLost: true,
          executedActions: ctx.executed,
        });
      }, timeoutMs + 500);
      this.pendingRun = {
        id,
        resolve: (result) => {
          if (options.signal?.aborted) {
            void this.terminate();
            resolve({ ...result, ok: false, error: { name: 'Cancelled', message: 'Code run cancelled.' } });
          } else resolve(result);
        },
        reject,
        timer,
        ctx,
        accepting: true,
        rpcTail: Promise.resolve(),
        activeRpcs: 0,
        startedAt: Date.now(),
      };
      const onAbort = () => void this.terminate().then(() => {
        const pending = this.pendingRun;
        if (pending?.id === id) {
          this.pendingRun = undefined;
          clearTimeout(pending.timer);
          pending.resolve({
            ok: false,
            logs: [],
            error: { name: 'Cancelled', message: 'Code run cancelled.' },
            durationMs: Date.now() - pending.startedAt,
            timedOut: false,
            stopped: true,
            sessionLost: true,
            executedActions: ctx.executed,
          });
        }
      });
      if (options.signal) {
        this.pendingRun!.cleanup = () => options.signal!.removeEventListener('abort', onAbort);
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.send({ type: 'run', id, code, timeoutMs });
    });
  }

  private async terminate(): Promise<boolean> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.ready = false;
      this.lost = true;
      return this.inFlightUi === 0;
    }
    await this.killTree();
    const exited = await waitForExit(child, 1_500);
    this.ready = false;
    this.lost = true;
    return exited && this.inFlightUi === 0;
  }

  private async killTree(): Promise<void> {
    const child = this.child;
    if (!child || !child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null) {
      this.send({ type: 'close' });
      await waitForExit(child, 500);
      if (child.exitCode === null) await this.killTree();
    }
    await rm(this.scratch ?? '', { recursive: true, force: true }).catch(() => undefined);
    this.child = undefined;
    this.ready = false;
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
