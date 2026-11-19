import { EventEmitter } from 'events';
import type http from 'http';
import { describe, expect, it, vi } from 'vitest';
import { RemoteServer } from './server';

function request(server: RemoteServer, path = '/cmd', method = 'POST', requestKey?: string) {
  server.token ??= 'test-token';
  const req = Object.assign(new EventEmitter(), {
    url: path, method, headers: { host: 'localhost', 'x-remote-token': server.token, 'x-remote-client': requestKey },
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

describe('native remote request replies', () => {
  const keyA = '1b1b6b51-2657-4b2c-b61c-111111111111';
  const keyB = '2b1b6b51-2657-4b2c-b61c-222222222222';

  it('returns a private reply only to the requesting stream even when request IDs collide', () => {
    const server = new RemoteServer();
    const run = vi.fn();
    server.on('command', run);
    const a = request(server, '/events', 'GET', keyA);
    const b = request(server, '/events', 'GET', keyB);
    const legacy = request(server, '/events', 'GET');
    try {
      const command = { type: 'remoteWork', action: 'state', reqId: 'same-id' };
      request(server, '/cmd', 'POST', keyA).send(command);
      request(server, '/cmd', 'POST', keyB).send(command);
      const idA = run.mock.calls[0][0].reqId;
      const idB = run.mock.calls[1][0].reqId;
      expect(idA).not.toBe(idB);
      expect(idA).not.toBe(command.reqId);
      server.publish({ type: 'reply', reqId: idA, ok: true, content: 'A' });
      expect(a.res.write).toHaveBeenLastCalledWith(expect.stringContaining('"reqId":"same-id","ok":true,"content":"A"'));
      expect(b.res.write).toHaveBeenCalledTimes(2);
      expect(legacy.res.write).toHaveBeenCalledTimes(2);

      a.res.emit('close');
      server.publish({ type: 'reply', reqId: idA, ok: true, content: 'late' });
      server.publish({ type: 'reply', reqId: idB, ok: true, content: 'B' });
      expect(a.res.write).toHaveBeenCalledTimes(3);
      expect(b.res.write).toHaveBeenLastCalledWith(expect.stringContaining('"content":"B"'));
      expect(legacy.res.write).toHaveBeenCalledTimes(2);
    } finally {
      a.res.emit('close');
      b.res.emit('close');
      legacy.res.emit('close');
    }
  });

  it('requires a live private stream for new requests while legacy requests keep working', () => {
    const server = new RemoteServer();
    const run = vi.fn();
    server.on('command', run);
    const unbound = request(server, '/cmd', 'POST', keyA);
    unbound.send({ type: 'remoteSettings', reqId: 'request-a' });
    expect(unbound.res.status).toBe(409);
    const legacy = request(server);
    legacy.send({ type: 'remoteSettings', reqId: 'request-b' });
    expect(legacy.res.status).toBe(409);
    expect(run).not.toHaveBeenCalled();
    request(server).send({ type: 'listDir', reqId: 'old-request' });
    expect(run).toHaveBeenCalledWith({ type: 'listDir', reqId: 'old-request' });
  });
});
