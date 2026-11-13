import { EventEmitter } from 'events';
import type http from 'http';
import { describe, expect, it, vi } from 'vitest';
import { RemoteServer } from './server';

function request(server: RemoteServer, path = '/cmd', method = 'POST') {
  server.token ??= 'test-token';
  const req = Object.assign(new EventEmitter(), {
    url: path, method, headers: { host: 'localhost', 'x-remote-token': server.token },
    socket: { remoteAddress: '127.0.0.1' }, setTimeout: vi.fn(), destroy: vi.fn(),
  });
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, status: 0, body: '',
    writeHead(status: number) { this.status = status; return this; },
    end(body?: string) { this.body = body || ''; this.writableEnded = true; return this; },
    setHeader: vi.fn(), write: vi.fn(), flushHeaders: vi.fn(),
  });
  (server as unknown as { handle(req: http.IncomingMessage, res: http.ServerResponse): void }).handle(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
  return { req, res, send(body: unknown) { req.emit('data', JSON.stringify(body)); req.emit('end'); } };
}

describe('remote commands after switching screen control to UU', () => {
  it('removes the old screenshot and input route', () => {
    const server = new RemoteServer();
    const run = vi.fn();
    server.on('desktop', run);
    const r = request(server, '/desktop');
    r.send({ type: 'desktopFrame' });
    expect(r.res.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });
  it('refuses a command authenticated before access was revoked', () => {
    const server = new RemoteServer();
    const run = vi.fn();
    server.on('command', run);
    const r = request(server);
    server.stop();
    r.send({ type: 'send', text: 'late input' });
    expect(r.req.destroy).toHaveBeenCalled();
    expect(r.res.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });
  it('rechecks the password after receiving a delayed request body', () => {
    const server = new RemoteServer();
    const run = vi.fn();
    server.on('command', run);
    const r = request(server);
    server.setPassword('changed');
    r.send({ type: 'send', text: 'stale' });
    expect(r.res.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });
  it('preserves Chinese text and emoji across TCP UTF-8 splits', () => {
    const server = new RemoteServer();
    const run = vi.fn();
    server.on('command', run);
    const r = request(server);
    const body = Buffer.from(JSON.stringify({ type: 'send', text: '中文😀' }));
    for (const byte of body) r.req.emit('data', Buffer.from([byte]));
    r.req.emit('end');
    expect(run.mock.calls[0][0].text).toBe('中文😀');
    expect(r.res.status).toBe(200);
  });
  it('publishes the UU screen provider while retaining native state', () => {
    const server = new RemoteServer();
    server.publish({ type: 'state', snapshot: { viewMode: 'work', messages: [] } });
    const r = request(server, '/api/state', 'GET');
    expect(r.res.status).toBe(200);
    expect(JSON.parse(r.res.body).snapshot).toMatchObject({ viewMode: 'work', messages: [], screenControlProvider: 'uuRemote' });
  });
});
