import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { ZodError } from 'zod';
import { CuaError, serializeError } from '../protocol/errors.js';
import { ControlActionSchema, UserInputSchema } from '../protocol/schemas.js';
import type { RuntimeService } from './runtime-service.js';

export interface HttpServerOptions {
  host?: string;
  port?: number;
  token?: string;
  tokenFile?: string;
  consoleDir?: string;
  ssePollMs?: number;
  /** For containers published exclusively to host loopback. Not remote hosting. */
  allowNonLoopbackBind?: boolean;
}

export interface HttpServerInfo {
  url: string;
  host: string;
  port: number;
  token: string;
  tokenFile: string;
  console: boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Local-only HTTP API consumed by the React console, CLI, SDK and MCP adapter.
 * The server binds 127.0.0.1 and requires a random bearer token written with
 * 0600 permissions. No cloud/multi-tenant mode is implied.
 */
export class CuaHttpServer {
  private server?: Server;
  private info?: HttpServerInfo;

  constructor(private readonly service: RuntimeService, private readonly options: HttpServerOptions = {}) {}

  async start(): Promise<HttpServerInfo> {
    const host = this.options.host ?? '127.0.0.1';
    const wildcardAllowed = (this.options.allowNonLoopbackBind ?? process.env.CUA_ALLOW_NON_LOOPBACK_BIND === '1') && ['0.0.0.0', '::'].includes(host);
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !wildcardAllowed) {
      throw new CuaError('AUTHORIZATION_DENIED', 'The local console requires a loopback bind address. Remote deployment is not supported.');
    }
    const tokenFile = resolve(this.options.tokenFile ?? join(this.service.config.dataDir, 'server-token'));
    let token: string;
    if (this.options.token) {
      token = this.options.token;
      await mkdir(dirname(tokenFile), { recursive: true });
      await writeFile(tokenFile, token, { mode: 0o600 });
      await chmod(tokenFile, 0o600);
    } else {
      token = await this.loadOrCreateToken(tokenFile);
    }
    const consoleDir = resolve(this.options.consoleDir ?? join(process.cwd(), 'console', 'dist'));
    const server = createServer((req, res) => void this.handle(req, res, consoleDir));
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 4317, host, () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server did not bind');
    this.server = server;
    const clientHost = wildcardAllowed ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
    this.info = { url: `http://${clientHost}:${address.port}`, host, port: address.port, token, tokenFile, console: existsSync(join(consoleDir, 'index.html')) };
    await mkdir(dirname(tokenFile), { recursive: true });
    await writeFile(
      join(dirname(tokenFile), 'server.json'),
      JSON.stringify({ url: this.info.url, tokenFile, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    return this.info;
  }

  private async loadOrCreateToken(path: string): Promise<string> {
    try {
      const token = (await readFile(path, 'utf8')).trim();
      if (token) {
        await chmod(path, 0o600);
        return token;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const token = randomBytes(32).toString('base64url');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, token, { mode: 0o600 });
    await chmod(path, 0o600);
    return token;
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.info) return false;
    const auth = req.headers.authorization;
    if (auth === `Bearer ${this.info.token}`) return true;
    return false;
  }

  private async handle(req: IncomingMessage, res: ServerResponse, consoleDir: string): Promise<void> {
    try {
      // Check even public HTML: it contains the console token. A loopback bind
      // alone does not prevent DNS rebinding or cross-origin navigation attacks.
      const expected = new URL(this.info!.url);
      const localHosts = ['127.0.0.1', 'localhost', '[::1]'].map((host) => `${host}:${this.info!.port}`);
      if (!localHosts.includes(req.headers.host ?? '') || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
        this.json(res, 403, { error: { code: 'AUTHORIZATION_DENIED', message: 'Request Host or Origin does not match this local runtime.' } });
        return;
      }
      const url = new URL(req.url ?? '/', expected);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        await this.serveConsole(res, consoleDir);
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        await this.serveStatic(res, consoleDir, url.pathname);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        this.json(res, 200, {
          ok: true,
          name: 'cua-runtime',
          version: '0.1.0',
          protocolVersion: 1,
          uptimeMs: Math.round(process.uptime() * 1_000),
          platform: process.platform,
          drivers: {
            browser: 'playwright-chromium',
            desktop: process.platform === 'darwin' ? 'macos-cgevent+textedit-scripting' : 'unsupported',
            codeSandbox: process.platform === 'darwin' ? 'sandbox-exec+node-permission-model' : 'unsupported-so-far',
          },
          auth: 'bearer-token-local-only',
        });
        return;
      }
      if (!this.authorized(req)) {
        this.json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid bearer token.' } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        this.json(res, 200, { tasks: this.service.listTasks(integerParameter(url.searchParams.get('limit'), 100, 'limit', 1, 100)) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const body = await readBody(req);
        const task = await this.service.createTask(body);
        this.json(res, 201, task);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/metrics') {
        this.json(res, 200, this.service.metrics());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/workflows') {
        this.json(res, 200, { workflows: this.service.listWorkflows() });
        return;
      }
      const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
      if (req.method === 'DELETE' && workflowMatch) {
        this.json(res, 200, { schemaVersion: 1, deleted: this.service.deleteWorkflow(decodeURIComponent(workflowMatch[1]!)) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const since = eventCursor(url, req);
        if (url.searchParams.get('stream') === '1') {
          await this.streamEvents(req, res, since);
          return;
        }
        this.json(res, 200, { events: this.service.getEvents(undefined, since, 500) });
        return;
      }
      const artifactMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)$/);
      if (req.method === 'GET' && artifactMatch) {
        try {
          const { record, bytes } = await this.service.getArtifact(decodeURIComponent(artifactMatch[1]!));
          const mime = record.kind.includes('screenshot') ? 'image/png' : mimeFor(record.path);
          res.writeHead(200, { 'content-type': mime, 'cache-control': 'private, max-age=60' });
          res.end(bytes);
          return;
        } catch (error) {
          this.json(res, 404, { error: serializeError(error) });
          return;
        }
      }
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(.*))?$/);
      if (taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1]!);
        const sub = taskMatch[2];
        this.service.store.requireTask(taskId);
        if (req.method === 'GET' && !sub) {
          this.json(res, 200, this.service.getTask(taskId));
          return;
        }
        if (req.method === 'GET' && sub === 'events') {
          const since = eventCursor(url, req);
          if (url.searchParams.get('stream') === '1') {
            await this.streamEvents(req, res, since, taskId);
            return;
          }
          this.json(res, 200, { events: this.service.getEvents(taskId, since, 1_000) });
          return;
        }
        if (req.method === 'POST' && sub === 'control') {
          const body = objectBody(await readBody(req));
          const action = ControlActionSchema.parse(body.action);
          let task;
          switch (action) {
            case 'pause':
              task = await this.service.pause(taskId);
              break;
            case 'resume':
              task = await this.service.resume(taskId);
              break;
            case 'cancel':
              task = await this.service.cancel(taskId, String(body.reason ?? 'Cancelled by user'));
              break;
            case 'takeover':
              task = await this.service.takeover(taskId);
              break;
            case 'release':
              task = await this.service.release(taskId);
              break;
            case 'recover':
              task = await this.service.recoverTask(taskId);
              break;
          }
          this.json(res, 200, task);
          return;
        }
        if (req.method === 'POST' && sub === 'input') {
          const body = UserInputSchema.parse(await readBody(req));
          this.json(res, 200, await this.service.submitInput(taskId, body));
          return;
        }
        if (req.method === 'POST' && sub === 'workflow/invalidate') {
          this.service.invalidateWorkflow(taskId);
          this.json(res, 200, { ok: true, workflows: this.service.listWorkflows() });
          return;
        }
      }
      this.json(res, 404, { error: { code: 'TASK_NOT_FOUND', message: `No route for ${req.method} ${url.pathname}.` } });
      return;
    } catch (error) {
      const serialized = serializeError(error instanceof ZodError || error instanceof URIError
        ? new CuaError('PROTOCOL_INVALID', error.message)
        : error);
      const status =
        serialized.code === 'TASK_NOT_FOUND'
          ? 404
          : serialized.code === 'CONFLICT'
            ? 409
            : serialized.code === 'AUTHORIZATION_DENIED' || serialized.code === 'APPROVAL_REQUIRED'
              ? 403
              : serialized.code === 'PROTOCOL_INVALID'
                ? 400
                : serialized.code === 'MODEL_CAPABILITY_MISSING'
                  ? 400
                  : 500;
      if (!res.headersSent) this.json(res, status, { error: serialized });
      else res.end();
    }
  }

  private async serveConsole(res: ServerResponse, consoleDir: string): Promise<void> {
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('referrer-policy', 'no-referrer');
    const indexPath = join(consoleDir, 'index.html');
    if (!existsSync(indexPath)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>CUA runtime</title>
<body style="font-family:system-ui;max-width:720px;margin:60px auto">
<h1>Computer Use Agent runtime</h1>
<p>The API is running. The React console is not built yet.</p>
<pre>cd cua && npm run console:build</pre>
<p>API: <code>/api/health</code>, <code>/api/tasks</code>. Authentication uses the bearer token in <code>.cua/server-token</code>.</p>
</body>`);
      return;
    }
    let html = await readFile(indexPath, 'utf8');
    // The console is served only from the localhost-bound server. The token is
    // injected so the React app can call the API without a login screen.
    html = html.replace(
      '</head>',
      `<script>window.__CUA_TOKEN__=${scriptJson(this.info!.token)};window.__CUA_API__=window.location.origin;</script></head>`,
    );
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  private async serveStatic(res: ServerResponse, root: string, pathname: string): Promise<void> {
    const relative = normalize(pathname.replace(/^\/+/, ''));
    const path = resolve(root, relative);
    if (!path.startsWith(resolve(root) + '/') && path !== resolve(root)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error('not a file');
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=300' });
      createReadStream(path).pipe(res);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }

  private async streamEvents(req: IncomingMessage, res: ServerResponse, since: number, taskId?: string): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    let seq = since;
    let closed = false;
    let backpressured = false;
    let lastWrite = Date.now();
    res.on('drain', () => { backpressured = false; });
    const pollMs = this.options.ssePollMs ?? 250;
    const timer = setInterval(() => {
      if (closed || backpressured) return;
      try {
        const events = this.service.getEvents(taskId, seq, 200);
        for (const event of events) {
          seq = Math.max(seq, event.seq);
          backpressured = !res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
          lastWrite = Date.now();
          if (backpressured) break;
        }
        if (Date.now() - lastWrite >= 15_000) {
          backpressured = !res.write(': heartbeat\n\n');
          lastWrite = Date.now();
        }
      } catch {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'event poll failed' })}\n\n`);
      }
    }, pollMs);
    req.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
    res.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      // SSE clients are long-lived; do not let them block shutdown.
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        resolveClose();
      }, 250);
      timer.unref?.();
    });
  }

  get address(): HttpServerInfo | undefined {
    return this.info;
  }
}

function mimeFor(path: string): string {
  return MIME[extname(path)] ?? 'application/octet-stream';
}

function integerParameter(raw: string | undefined | null, fallback: number, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new CuaError('PROTOCOL_INVALID', `${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function eventCursor(url: URL, req: IncomingMessage): number {
  const lastId = req.headers['last-event-id'];
  return integerParameter(url.searchParams.get('since') ?? (typeof lastId === 'string' ? lastId : undefined), 0, 'since', 0);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CuaError('PROTOCOL_INVALID', 'Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}

function scriptJson(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new CuaError('PROTOCOL_INVALID', 'Request body exceeds 2MB.');
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CuaError('PROTOCOL_INVALID', 'Request body is not valid JSON.');
  }
}

export { createInterface };
