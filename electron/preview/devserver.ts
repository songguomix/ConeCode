import http from 'http';
import path from 'path';
import fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import {
  detectPreview, extractUrl, resolveStaticPath, contentTypeFor,
  type PreviewMode, type PreviewPlan, type PreviewStatus, type PreviewLog,
} from '../../src/core/preview/preview';

// Runs the *user's* project so the built-in browser can show it. Two shapes
// cover almost everything the agent generates:
//
//   script — the project has a package.json with a dev/start script. We spawn
//            it and sniff the local URL out of its output (vite, next, CRA,
//            astro… all print one), because the port is the framework's choice.
//   static — the project is plain HTML with no build step. There's nothing to
//            spawn, so we serve the folder ourselves over loopback and watch it
//            for edits, giving generated pages live-reload for free.
//
// Which of the two applies, and the rules for reading dev-server output, live in
// core/preview/preview.ts; this module owns the process and the socket.

export { detectPreview };
export type { PreviewMode, PreviewPlan, PreviewStatus, PreviewLog };

class PreviewManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private staticServer: http.Server | null = null;
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private urlTimer: NodeJS.Timeout | null = null;
  private status: PreviewStatus = { state: 'idle', url: null, plan: null, error: null, pid: null };
  /** Login-shell environment, supplied by main so `npm`/`node` resolve. */
  private env: NodeJS.ProcessEnv | null = null;

  setEnv(env: NodeJS.ProcessEnv): void {
    this.env = env;
  }

  getStatus(): PreviewStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<PreviewStatus>): PreviewStatus {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
    return this.getStatus();
  }

  private log(stream: PreviewLog['stream'], data: string): void {
    this.emit('log', { stream, data } as PreviewLog);
  }

  /**
   * Start (or restart) a preview. `command` overrides detection — that's what
   * the command box in the panel sends when the user knows better.
   */
  async start(opts: { cwd: string; command?: string | null }): Promise<PreviewStatus> {
    await this.stop();

    const cwd = opts.cwd;
    if (!cwd || !fs.existsSync(cwd)) {
      return this.setStatus({ state: 'error', error: 'noFolder', url: null, plan: null, pid: null });
    }

    const plan: PreviewPlan | null = opts.command
      ? { mode: 'command', command: opts.command, cwd }
      : detectPreview(cwd);

    if (!plan) {
      return this.setStatus({ state: 'error', error: 'notDetected', url: null, plan: null, pid: null });
    }

    this.setStatus({ state: 'starting', url: null, plan, error: null, pid: null });
    return plan.mode === 'static' ? this.startStatic(plan) : this.startProcess(plan);
  }

  // ---- static mode ---------------------------------------------------------

  private startStatic(plan: PreviewPlan): Promise<PreviewStatus> {
    const root = plan.staticDir || plan.cwd;
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.serveStatic(root, req, res));
      server.on('error', (err: any) => {
        this.log('system', `static server failed: ${err?.message || err}\n`);
        resolve(this.setStatus({ state: 'error', error: err?.message || 'serverFailed' }));
      });
      // Loopback only: the preview is for this machine, not the network.
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        const entry = plan.staticEntry && plan.staticEntry !== 'index.html' ? `/${plan.staticEntry}` : '/';
        const url = `http://localhost:${port}${entry}`;
        this.staticServer = server;
        this.watchStatic(root);
        this.log('system', `Serving ${root} → ${url}\n`);
        resolve(this.setStatus({ state: 'running', url, error: null }));
      });
    });
  }

  private serveStatic(root: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    let pathname = '/';
    try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname); } catch {}

    const resolved = resolveStaticPath(root, pathname);
    if (!resolved) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let file = resolved;
    try {
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      // Unknown path with no extension → hand it to index.html so client-side
      // routers (hash-less SPAs) still resolve.
      if (!fs.existsSync(file) && !path.extname(file)) file = path.join(root, 'index.html');
      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentTypeFor(file),
        // Never cache: the whole point is that the next reload shows new edits.
        'Cache-Control': 'no-store, must-revalidate',
      }).end(fs.readFileSync(file));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(err?.message || err));
    }
  }

  // Static projects have no HMR, so give them the next best thing: watch the
  // folder and tell the renderer to reload the webview after edits settle.
  private watchStatic(root: string): void {
    try {
      this.watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : '';
        if (name.includes('node_modules') || name.includes('.git')) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.emit('reload'), 180);
      });
    } catch {
      // Recursive watching isn't available everywhere; live-reload is a bonus,
      // so a failure here just means the user reloads by hand.
    }
  }

  // ---- process mode --------------------------------------------------------

  private startProcess(plan: PreviewPlan): PreviewStatus {
    const command = plan.command!;
    this.log('system', `$ ${command}\n`);

    let proc: ChildProcess;
    try {
      proc = spawn(command, {
        cwd: plan.cwd,
        env: {
          ...(this.env || process.env),
          FORCE_COLOR: '0',
          // Ask the common dev servers not to hijack the user's real browser —
          // the whole point is that it opens *here*.
          BROWSER: 'none',
          OPEN: 'none',
        },
        shell: true,
        // Own process group, so stopping kills the shell *and* the server it spawned.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      return this.setStatus({ state: 'error', error: err?.message || 'spawnFailed' });
    }

    this.proc = proc;
    this.setStatus({ pid: proc.pid ?? null });

    const onData = (stream: 'stdout' | 'stderr') => (buf: Buffer) => {
      const text = buf.toString();
      this.log(stream, text);
      if (this.status.url) return;
      const url = extractUrl(text);
      if (url) {
        this.clearUrlTimer();
        this.setStatus({ state: 'running', url, error: null });
      }
    };
    proc.stdout?.on('data', onData('stdout'));
    proc.stderr?.on('data', onData('stderr'));

    proc.on('error', (err: any) => {
      this.log('system', `${err?.message || err}\n`);
      this.setStatus({ state: 'error', error: err?.message || 'spawnFailed', pid: null });
    });

    proc.on('close', (code) => {
      if (this.proc !== proc) return; // superseded by a restart
      this.proc = null;
      this.clearUrlTimer();
      this.log('system', `\nProcess exited with code ${code ?? 0}\n`);
      // A dev server that exits on its own is a failure unless we stopped it.
      this.setStatus(
        this.status.state === 'idle'
          ? { pid: null }
          : { state: 'error', error: `exit:${code ?? 0}`, url: null, pid: null },
      );
    });

    // Some servers print their URL only once, before we attach, or not at all.
    // After a grace period, stop pretending we're still booting: the panel then
    // shows the log and lets the user type the address.
    this.urlTimer = setTimeout(() => {
      if (this.status.state === 'starting') this.setStatus({ state: 'running', url: null });
    }, 25000);

    return this.getStatus();
  }

  private clearUrlTimer(): void {
    if (this.urlTimer) { clearTimeout(this.urlTimer); this.urlTimer = null; }
  }

  // ---- teardown ------------------------------------------------------------

  async stop(): Promise<PreviewStatus> {
    this.clearUrlTimer();
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); this.reloadTimer = null; }

    if (this.watcher) {
      try { this.watcher.close(); } catch {}
      this.watcher = null;
    }
    if (this.staticServer) {
      const server = this.staticServer;
      this.staticServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const proc = this.proc;
    if (proc) {
      this.proc = null;
      killTree(proc);
    }
    return this.setStatus({ state: 'idle', url: null, error: null, pid: null });
  }
}

// `npm run dev` is a shell that spawns the real server; killing only the shell
// would leave the port bound. Kill the whole group (POSIX) / tree (Windows).
function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
      // Escalate if the group ignores the polite request.
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 2500).unref?.();
    }
  } catch {
    try { proc.kill('SIGKILL'); } catch {}
  }
}

export const previewManager = new PreviewManager();
