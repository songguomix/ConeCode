import http from 'http';
import https from 'https';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { getMobileClientHtml } from './mobileClient';
import { loadRemoteTls, type RemoteTls } from './tls';

// A tiny HTTPS + Server-Sent-Events bridge that lets a phone mirror and control
// the desktop ConeCode session. The desktop renderer remains the single source
// of truth: it pushes state snapshots through `publish()` (fanned out to every
// connected phone over SSE) and receives phone actions via the `command` event.
//
// SSE (not WebSocket) keeps this dependency-free — server→phone push is the only
// streaming direction we need; phone→server actions go through plain POST /cmd.
//
// TLS identity is generated locally and persisted per installation. Clients must
// pair with this installation's certificate; no shared private key is bundled.
// Every route also requires the fresh random token minted by start().

export interface RemoteCommand {
  type: string;
  [key: string]: any;
}

interface RemoteDevice {
  res: http.ServerResponse;
  ip: string;
  since: number;
}

class RemoteServer extends EventEmitter {
  private server: https.Server | null = null;
  private starting: Promise<{ port: number; token: string }> | null = null;
  private generation = 0;
  // Connected phones, keyed by a per-connection id so the UI can list/kick them.
  private clients = new Map<string, RemoteDevice>();
  private clientSeq = 0;
  // IPs kicked this session; rejected with 403 so they can't reconnect. Cleared on stop.
  private blocked = new Set<string>();
  // The most recent state frame, replayed to any phone that (re)connects.
  private latest: any = { type: 'state', snapshot: null };

  port: number | null = null;
  token: string | null = null;
  /** SHA-256 of this install's remote TLS cert — phones pin it via `fp=`. */
  fingerprint: string | null = null;
  // Optional extra login factor. The token rides in the QR (convenience); the
  // password is entered/stored separately, so seeing the QR alone isn't enough.
  // Persisted by the renderer and re-applied on start; kept across stop().
  private password: string | null = null;

  setPassword(pw: string | null): void {
    this.password = pw && pw.length > 0 ? pw : null;
  }

  hasPassword(): boolean {
    return !!this.password;
  }

  getPassword(): string | null {
    return this.password;
  }

  isRunning(): boolean {
    return !!this.server;
  }

  clientCount(): number {
    return this.clients.size;
  }

  // Connected phones, for the desktop "connected devices" list.
  clientList(): { id: string; ip: string; since: number }[] {
    return [...this.clients.entries()].map(([id, c]) => ({ id, ip: c.ip, since: c.since }));
  }

  // Forcibly disconnect a phone (the desktop "kick" button).
  kick(id: string): void {
    const c = this.clients.get(id);
    if (c) {
      if (c.ip && c.ip !== 'unknown') this.blocked.add(c.ip); // keep it out on reconnect
      try { c.res.end(); } catch {}
      if (this.clients.delete(id)) this.emit('clients', this.clients.size);
    }
  }

  // Re-allow a previously kicked IP.
  unblock(ip: string): void {
    this.blocked.delete(ip);
  }

  async start(dataDir: string, preferredPort = 8723): Promise<{ port: number; token: string }> {
    if (this.starting) return this.starting;
    if (this.server && this.port && this.token) return { port: this.port, token: this.token };
    const generation = this.generation;
    const starting = (async () => {
      const tls = await loadRemoteTls(dataDir);
      if (generation !== this.generation) throw new Error('Remote start cancelled');
      this.token = crypto.randomBytes(16).toString('hex');
      this.fingerprint = tls.fingerprint;
      const port = await this.listen(preferredPort, tls);
      if (generation !== this.generation) {
        this.stop();
        throw new Error('Remote start cancelled');
      }
      this.port = port;
      return { port, token: this.token! };
    })();
    this.starting = starting;
    try { return await starting; }
    finally { if (this.starting === starting) this.starting = null; }
  }

  stop(): void {
    this.generation++;
    for (const c of this.clients.values()) {
      try { c.res.end(); } catch {}
    }
    this.clients.clear();
    this.blocked.clear();
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }
    this.port = null;
    this.token = null;
    this.fingerprint = null;
    // Keep the last state frame: the renderer keeps running, so it stays current,
    // and it is replayed to the next phone that connects after a restart — without
    // it, a reconnect would receive a null snapshot and the phone would never leave
    // its connect screen until something on the desktop changed.
    this.emit('clients', 0);
  }

  // Fan a frame out to every connected phone and remember it as the replay value.
  publish(frame: any): void {
    if (frame && frame.type === 'state') this.latest = frame;
    const data = `data: ${JSON.stringify(frame)}\n\n`;
    for (const c of this.clients.values()) {
      try { c.res.write(data); } catch {}
    }
  }

  // Bind to `preferred`, scanning upward a few ports if it is already in use.
  private listen(preferred: number, tls: RemoteTls): Promise<number> {
    return new Promise((resolve, reject) => {
      let port = preferred;
      let attempts = 0;
      const srv = https.createServer(
        tls,
        (req, res) => this.handle(req, res),
      );
      srv.on('error', (err: any) => {
        if (err?.code === 'EADDRINUSE' && attempts < 20) {
          attempts++;
          port++;
          setTimeout(() => srv.listen(port, '0.0.0.0'), 0);
        } else {
          reject(err);
        }
      });
      srv.on('listening', () => {
        this.server = srv;
        resolve(port);
      });
      srv.listen(port, '0.0.0.0');
    });
  }

  private authed(req: http.IncomingMessage, url: URL): boolean {
    const t = url.searchParams.get('t') || (req.headers['x-remote-token'] as string) || '';
    if (!this.token || t !== this.token) return false;
    const p = url.searchParams.get('p') || (req.headers['x-remote-pass'] as string) || '';
    if (this.password) {
      // A password is set → every route requires it (header for the native app,
      // `?p=` query for the EventSource-based web client).
      if (p !== this.password) return false;
    } else {
      // No password set → LAN is allowed, but PUBLIC (tunnel) access is not: a
      // request that arrived via a tunnel carries forwarding headers (Cloudflare's
      // cf-connecting-ip / cf-ray, or ngrok's x-forwarded-*). Reject those so the
      // public link can never be used without a password.
      const viaTunnel = !!(
        req.headers['cf-connecting-ip'] ||
        req.headers['cf-ray'] ||
        req.headers['x-forwarded-for'] ||
        req.headers['x-forwarded-host']
      );
      if (viaTunnel) return false;
    }
    return true;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    // A kicked device is blocked by IP so it can't immediately reconnect (the
    // token alone would otherwise let it straight back in). 403 → the phone stops.
    if (this.blocked.has(clientIp(req))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    if (!this.authed(req, url)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized');
      return;
    }

    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getMobileClientHtml());
      return;
    }

    if (path === '/api/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(this.latest));
      return;
    }

    if (path === '/events' && req.method === 'GET') {
      this.openStream(req, res);
      return;
    }

    if (path === '/cmd' && req.method === 'POST') {
      this.readCommand(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  private openStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    // Replay current state immediately so a fresh phone renders without waiting.
    try { res.write(`data: ${JSON.stringify(this.latest)}\n\n`); } catch {}

    const id = String(++this.clientSeq);
    this.clients.set(id, { res, ip: clientIp(req), since: Date.now() });
    this.emit('clients', this.clients.size);

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 25000);

    const close = () => {
      clearInterval(ping);
      if (this.clients.delete(id)) this.emit('clients', this.clients.size);
    };
    req.on('close', close);
    res.on('close', close);
  }

  private readCommand(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      // Generous cap so phone "upload file" (base64) fits; still bounds abuse.
      if (body.length > 30_000_000) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) {
        res.writeHead(413).end();
        return;
      }
      try {
        const cmd = JSON.parse(body || '{}') as RemoteCommand;
        if (cmd && typeof cmd.type === 'string') this.emit('command', cmd);
      } catch {
        // Ignore malformed commands.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  }
}

// Best-effort client IP: the tunnel forwards the real visitor IP in
// cf-connecting-ip / x-forwarded-for; LAN connects expose it on the socket.
function clientIp(req: http.IncomingMessage): string {
  const fwd =
    (req.headers['cf-connecting-ip'] as string) ||
    ((req.headers['x-forwarded-for'] as string) || '').split(',')[0].trim();
  let ip = fwd || req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  return ip || 'unknown';
}

export const remoteServer = new RemoteServer();
