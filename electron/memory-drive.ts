// Google Drive memory cloud — main process.
//
// OAuth 2.0 for desktop apps uses a loopback redirect + PKCE. The refresh
// token, client secret and access token live in a small file encrypted with
// Electron safeStorage; they never cross the preload bridge. The renderer sees
// only status and narrow Drive operations.
//
// Structured memory is stored as one JSON document in Drive's hidden
// appDataFolder. Updates are ETag-conditional, so two devices cannot silently
// overwrite each other; the existing MemorySyncEngine turns the returned
// conflicts into human-resolvable entries. This is intentionally a snapshot
// remote, not a fake transactional database.

import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import type {
  CloudUsage, GoogleDriveStatus, MemoryChange, MemoryConflict, MemoryQuery,
  MemoryRecord, SearchHit, StorageHealth,
} from '../src/core/memory/v2/types';
import { normalizeRecord } from '../src/core/memory/v2/model';
import { searchRecords } from '../src/core/memory/v2/retrieval';
import type { Memory2SecretCodec } from './memory2.store';

const AUTH_FILE = 'memory-drive-auth.json';
const STATE_PREFIX = 'conecode-memory2-';
const BACKUP_PREFIX = 'conecode-memory2-backup-';
const OBJECT_PREFIX = 'conecode-object-';
const SCOPE = [
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

interface DriveCredentials {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  email?: string;
  connectedAt?: number;
}

interface DriveState {
  schema: 2;
  tenantId: string;
  seq: number;
  records: MemoryRecord[];
  changes: MemoryChange[];
  devices: { deviceId: string; lastSeenAt: number }[];
  updatedAt: number;
}

interface DriveFile {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
}

interface RemoteState {
  state: DriveState;
  fileId: string | null;
  etag: string | null;
}

function emptyState(tenantId: string): DriveState {
  return { schema: 2, tenantId, seq: 0, records: [], changes: [], devices: [], updatedAt: Date.now() };
}

function sanitize(value: string): string {
  return String(value || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
}

function stateFileName(tenantId: string): string {
  return `${STATE_PREFIX}${sanitize(tenantId)}.json`;
}

function objectFileName(tenantId: string, key: string): string {
  return `${OBJECT_PREFIX}${sanitize(tenantId)}-${sanitize(key.replace(/\//g, '-'))}.json`;
}

function normalizeState(raw: any, tenantId: string): DriveState {
  if (!raw || raw.schema !== 2) return emptyState(tenantId);
  return {
    schema: 2,
    tenantId,
    seq: Number.isFinite(raw.seq) ? raw.seq : 0,
    records: Array.isArray(raw.records)
      ? raw.records.map(normalizeRecord).filter((r: MemoryRecord | null): r is MemoryRecord => !!r)
      : [],
    changes: Array.isArray(raw.changes) ? raw.changes.filter((c: any) => c && typeof c.memoryId === 'string') : [],
    devices: Array.isArray(raw.devices) ? raw.devices.filter((d: any) => d && typeof d.deviceId === 'string') : [],
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface DriveMemoryOptions {
  dataDir: string;
  secrets?: Memory2SecretCodec;
  fetchImpl?: typeof fetch;
  openExternal?: (url: string) => Promise<void>;
  timeoutMs?: number;
  /** Fixed loopback port if the Google OAuth client requires an exact redirect URI. */
  redirectPort?: number;
}

export class DriveMemoryStore {
  private credsPath: string;
  private secrets?: Memory2SecretCodec;
  private fetchImpl: typeof fetch;
  private openExternal?: (url: string) => Promise<void>;
  private timeoutMs: number;
  private redirectPort: number;
  private authServer: http.Server | null = null;

  constructor(opts: DriveMemoryOptions) {
    this.credsPath = path.join(opts.dataDir, AUTH_FILE);
    this.secrets = opts.secrets;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.openExternal = opts.openExternal;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.redirectPort = opts.redirectPort && opts.redirectPort > 0 ? opts.redirectPort : 0;
  }

  // ---- credential vault ---------------------------------------------------

  private decode(value: unknown): string {
    if (typeof value !== 'string' || !value) return '';
    if (!value.startsWith('enc:v1:')) return value;
    if (!this.secrets) return '';
    try { return this.secrets.decrypt(value.slice('enc:v1:'.length)); } catch { return ''; }
  }

  private encode(value: unknown): string {
    if (typeof value !== 'string' || !value) return '';
    if (!this.secrets) return value;
    return `enc:v1:${this.secrets.encrypt(value)}`;
  }

  private readCreds(): DriveCredentials {
    try {
      const raw = JSON.parse(fs.readFileSync(this.credsPath, 'utf-8'));
      return {
        clientId: typeof raw.clientId === 'string' ? raw.clientId : '',
        clientSecret: this.decode(raw.clientSecret),
        refreshToken: this.decode(raw.refreshToken),
        accessToken: this.decode(raw.accessToken),
        expiresAt: Number.isFinite(raw.expiresAt) ? raw.expiresAt : 0,
        email: typeof raw.email === 'string' ? raw.email : '',
        connectedAt: Number.isFinite(raw.connectedAt) ? raw.connectedAt : 0,
      };
    } catch {
      return {};
    }
  }

  private writeCreds(creds: DriveCredentials): boolean {
    try {
      fs.mkdirSync(path.dirname(this.credsPath), { recursive: true });
      const onDisk = {
        ...creds,
        clientSecret: this.encode(creds.clientSecret),
        refreshToken: this.encode(creds.refreshToken),
        accessToken: this.encode(creds.accessToken),
      };
      const tmp = `${this.credsPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.credsPath);
      return true;
    } catch {
      return false;
    }
  }

  private envClient(): { clientId: string; clientSecret: string } {
    return {
      clientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
    };
  }

  private client(): { clientId: string; clientSecret: string; source: GoogleDriveStatus['source'] } {
    const saved = this.readCreds();
    const env = this.envClient();
    // A saved connected client must keep using its own credentials; an env
    // client is for fresh deployments and one-click setup.
    if (saved.clientId && saved.refreshToken) {
      return { clientId: saved.clientId, clientSecret: saved.clientSecret || '', source: 'saved' };
    }
    if (env.clientId) return { clientId: env.clientId, clientSecret: env.clientSecret, source: 'env' };
    if (saved.clientId) return { clientId: saved.clientId, clientSecret: saved.clientSecret || '', source: 'saved' };
    return { clientId: '', clientSecret: '', source: 'none' };
  }

  status(): GoogleDriveStatus {
    const creds = this.readCreds();
    const client = this.client();
    return {
      configured: !!client.clientId,
      connected: !!creds.refreshToken,
      email: creds.email || undefined,
      clientId: client.clientId || undefined,
      clientIdSet: !!client.clientId,
      source: client.source,
    };
  }

  configure(opts: { clientId?: string; clientSecret?: string }): GoogleDriveStatus {
    const current = this.readCreds();
    const next: DriveCredentials = {
      ...current,
      ...(opts.clientId !== undefined ? { clientId: opts.clientId.trim() } : {}),
      ...(opts.clientSecret !== undefined ? { clientSecret: opts.clientSecret.trim() } : {}),
    };
    this.writeCreds(next);
    return this.status();
  }

  // ---- OAuth --------------------------------------------------------------

  async connect(opts: { clientId?: string; clientSecret?: string } = {}): Promise<{ ok: boolean; status?: GoogleDriveStatus; error?: string }> {
    if (opts.clientId !== undefined || opts.clientSecret !== undefined) this.configure(opts);
    const client = this.client();
    if (!client.clientId) {
      return { ok: false, error: 'Google OAuth client id is not configured. Set GOOGLE_DRIVE_CLIENT_ID or enter one in Advanced.' };
    }
    if (!this.openExternal) return { ok: false, error: 'Cannot open a browser in this runtime' };

    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(24));
    const redirectUri = await new Promise<string>((resolve, reject) => {
      const server = http.createServer();
      this.authServer = server;
      server.once('error', reject);
      server.listen(this.redirectPort, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('could not allocate loopback port')); return; }
        resolve(`http://127.0.0.1:${address.port}/oauth2callback`);
      });
    }).catch((e: any) => {
      this.closeAuthServer();
      throw e;
    });

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', client.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPE);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('include_granted_scopes', 'true');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    const codePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.closeAuthServer();
        reject(new Error('Google Drive authorization timed out after 5 minutes'));
      }, 5 * 60_000);
      const server = this.authServer!;
      server.on('request', (req, res) => {
        try {
          const url = new URL(req.url || '/', redirectUri);
          if (url.pathname !== '/oauth2callback') { res.writeHead(404); res.end('not found'); return; }
          const error = url.searchParams.get('error');
          const returnedState = url.searchParams.get('state');
          const code = url.searchParams.get('code');
          const finish = (status: number, body: string) => {
            res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(body);
          };
          if (error) {
            finish(400, '<h2>ConeCode could not connect Google Drive.</h2><p>You can close this window.</p>');
            clearTimeout(timer);
            this.closeAuthServer();
            reject(new Error(error));
            return;
          }
          if (!code || returnedState !== state) {
            finish(400, '<h2>Invalid OAuth response.</h2>');
            clearTimeout(timer);
            this.closeAuthServer();
            reject(new Error('OAuth state mismatch or missing code'));
            return;
          }
          finish(200, '<h2>ConeCode connected to Google Drive.</h2><p>You can close this window and return to ConeCode.</p>');
          clearTimeout(timer);
          this.closeAuthServer();
          resolve(code);
        } catch (e: any) {
          clearTimeout(timer);
          this.closeAuthServer();
          reject(e);
        }
      });
    });
    // If openExternal fails before we await this promise, the timer would
    // otherwise reject with no handler attached.
    void codePromise.catch(() => undefined);

    try {
      await this.openExternal(authUrl.toString());
      const code = await codePromise;
      const token = await this.exchangeCode(client, code, verifier, redirectUri);
      if (!token.refresh_token) {
        const existing = this.readCreds();
        if (!existing.refreshToken) {
          return { ok: false, error: 'Google did not return a refresh token. Remove ConeCode from your Google account permissions and retry.' };
        }
      }
      const email = await this.fetchEmail(token.access_token).catch(() => '');
      const saved = this.readCreds();
      this.writeCreds({
        ...saved,
        clientId: client.clientId,
        clientSecret: client.clientSecret || saved.clientSecret || '',
        refreshToken: token.refresh_token || saved.refreshToken || '',
        accessToken: token.access_token,
        expiresAt: Date.now() + Math.max(30, token.expires_in || 3600) * 1000,
        email,
        connectedAt: Date.now(),
      });
      return { ok: true, status: this.status() };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    } finally {
      this.closeAuthServer();
    }
  }

  private closeAuthServer(): void {
    const server = this.authServer;
    this.authServer = null;
    if (server) {
      try { server.close(); } catch { /* ignore */ }
    }
  }

  private async exchangeCode(
    client: { clientId: string; clientSecret: string },
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<any> {
    const body = new URLSearchParams({
      client_id: client.clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    if (client.clientSecret) body.set('client_secret', client.clientSecret);
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error_description || data?.error || `token exchange failed (HTTP ${response.status})`);
    return data;
  }

  private async fetchEmail(accessToken: string): Promise<string> {
    const response = await this.fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return '';
    const data = await response.json().catch(() => ({}));
    return typeof data?.email === 'string' ? data.email : '';
  }

  async disconnect(): Promise<boolean> {
    const creds = this.readCreds();
    if (creds.refreshToken) {
      try {
        await this.fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(creds.refreshToken)}`, { method: 'POST' });
      } catch { /* best effort */ }
    }
    // Keep the public client id/secret so reconnecting is still one click.
    return this.writeCreds({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    });
  }

  private async accessToken(force = false): Promise<string> {
    const creds = this.readCreds();
    if (!force && creds.accessToken && creds.expiresAt && creds.expiresAt > Date.now() + 60_000) {
      return creds.accessToken;
    }
    if (!creds.refreshToken) throw new Error('Google Drive is not connected');
    const client = this.client();
    if (!client.clientId) throw new Error('Google OAuth client id is missing');
    const body = new URLSearchParams({
      client_id: client.clientId,
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
    });
    if (client.clientSecret) body.set('client_secret', client.clientSecret);
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error_description || data?.error || `token refresh failed (HTTP ${response.status})`);
    this.writeCreds({
      ...creds,
      accessToken: data.access_token,
      expiresAt: Date.now() + Math.max(30, data.expires_in || 3600) * 1000,
      refreshToken: data.refresh_token || creds.refreshToken,
    });
    return data.access_token;
  }

  // ---- Drive HTTP ---------------------------------------------------------

  private async driveFetch(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const token = await this.accessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
      if (response.status === 401 && retry) {
        await this.accessToken(true);
        return this.driveFetch(url, init, false);
      }
      return response;
    } catch (e: any) {
      throw new Error(e?.name === 'AbortError' ? `Google Drive request timed out after ${this.timeoutMs}ms` : (e?.message ?? String(e)));
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.driveFetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Google Drive HTTP ${response.status}: ${text.slice(0, 240)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async fileList(): Promise<DriveFile[]> {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('spaces', 'appDataFolder');
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('fields', 'files(id,name,modifiedTime,size)');
    const data = await this.json<{ files?: DriveFile[] }>(url.toString());
    return Array.isArray(data.files) ? data.files : [];
  }

  private async findFile(name: string): Promise<DriveFile | null> {
    const files = await this.fileList();
    return files.find((file) => file.name === name) ?? null;
  }

  private async download(fileId: string): Promise<{ text: string; etag: string | null }> {
    const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
    const text = await response.text();
    if (!response.ok) throw new Error(`Google Drive download failed (HTTP ${response.status}): ${text.slice(0, 240)}`);
    return { text, etag: response.headers.get('etag') };
  }

  private async fileEtag(fileId: string): Promise<string | null> {
    const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,modifiedTime`);
    if (!response.ok) return null;
    return response.headers.get('etag');
  }

  private async createFile(name: string, content: string): Promise<{ id: string; etag: string | null }> {
    const created = await this.json<{ id: string }>('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      body: JSON.stringify({ name, parents: ['appDataFolder'] }),
    });
    const response = await this.driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(created.id)}?uploadType=media`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content },
    );
    if (!response.ok) throw new Error(`Google Drive upload failed (HTTP ${response.status})`);
    return { id: created.id, etag: await this.fileEtag(created.id) };
  }

  private async updateFile(fileId: string, content: string, etag: string | null): Promise<{ ok: boolean; etag: string | null; conflict: boolean; error?: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (etag) headers['If-Match'] = etag;
    const response = await this.driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
      { method: 'PATCH', headers, body: content },
    );
    if (response.status === 412) return { ok: false, etag: null, conflict: true };
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ok: false, etag: null, conflict: false, error: `Google Drive update failed (HTTP ${response.status}): ${detail.slice(0, 240)}` };
    }
    return { ok: true, etag: await this.fileEtag(fileId), conflict: false };
  }

  private async deleteFile(fileId: string): Promise<boolean> {
    const response = await this.driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    return response.ok || response.status === 404;
  }

  // ---- remote state -------------------------------------------------------

  private async readRemote(tenantId: string): Promise<RemoteState> {
    const file = await this.findFile(stateFileName(tenantId));
    if (!file) return { state: emptyState(tenantId), fileId: null, etag: null };
    const downloaded = await this.download(file.id);
    let parsed: any = null;
    try { parsed = JSON.parse(downloaded.text); } catch { throw new Error('Google Drive memory file is not valid JSON'); }
    return { state: normalizeState(parsed, tenantId), fileId: file.id, etag: downloaded.etag ?? await this.fileEtag(file.id) };
  }

  private async writeRemote(remote: RemoteState, state: DriveState): Promise<{ ok: boolean; conflict: boolean; error?: string }> {
    state.updatedAt = Date.now();
    const content = JSON.stringify(state);
    if (remote.fileId) {
      const result = await this.updateFile(remote.fileId, content, remote.etag);
      if (!result.ok) return { ok: false, conflict: result.conflict, error: result.error };
      remote.etag = result.etag;
      return { ok: true, conflict: false };
    }
    const created = await this.createFile(stateFileName(state.tenantId), content);
    remote.fileId = created.id;
    remote.etag = created.etag;
    return { ok: true, conflict: false };
  }

  // ---- public storage operations -----------------------------------------

  async health(): Promise<StorageHealth> {
    const started = Date.now();
    const status = this.status();
    if (!status.configured) {
      return { ok: false, kind: 'cloud', configured: false, message: 'Google OAuth client id is not configured' };
    }
    if (!status.connected) {
      return { ok: false, kind: 'cloud', configured: true, message: 'Google Drive is not connected' };
    }
    try {
      const about = await this.json<any>('https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress),storageQuota(limit,usage)');
      const email = about?.user?.emailAddress || status.email || '';
      return {
        ok: true, kind: 'cloud', configured: true, latencyMs: Date.now() - started,
        message: `Google Drive · ${email || 'connected'}`,
      };
    } catch (e: any) {
      return { ok: false, kind: 'cloud', configured: true, message: e?.message ?? 'Google Drive connection failed' };
    }
  }

  async search(tenantId: string, query: MemoryQuery): Promise<SearchHit[]> {
    const remote = await this.readRemote(tenantId);
    return searchRecords(remote.state.records, query, { source: 'cloud' });
  }

  async remoteChanges(tenantId: string, since: number, limit = 200): Promise<{ changes: MemoryChange[]; cursor: number; error?: string }> {
    try {
      const remote = await this.readRemote(tenantId);
      return {
        changes: remote.state.changes.filter((c) => c.seq > since).slice(0, limit),
        cursor: remote.state.seq,
      };
    } catch (e: any) {
      return { changes: [], cursor: since, error: e?.message ?? 'Google Drive pull failed' };
    }
  }

  async pushChanges(tenantId: string, changes: MemoryChange[]): Promise<{
    ok: boolean; acceptedChangeIds: string[]; cursor: number; conflicts: MemoryConflict[]; error?: string;
  }> {
    try {
      const remote = await this.readRemote(tenantId);
      const state = remote.state;
      const byId = new Map(state.records.map((r) => [r.id, r]));
      const known = new Set(state.changes.map((c) => c.changeId));
      const acceptedChangeIds: string[] = [];
      const conflicts: MemoryConflict[] = [];

      for (const change of changes) {
        if (known.has(change.changeId)) { acceptedChangeIds.push(change.changeId); continue; }
        const current = byId.get(change.memoryId);
        const incoming = change.record ? normalizeRecord(change.record) : null;
        if (current && incoming
          && current.version >= incoming.version
          && current.deviceId !== incoming.deviceId
          && current.contentHash !== incoming.contentHash) {
          conflicts.push({
            id: `cf-${crypto.randomUUID()}`,
            memoryId: change.memoryId,
            local: incoming,
            remote: current,
            detectedAt: Date.now(),
            resolved: false,
          });
          acceptedChangeIds.push(change.changeId);
          continue;
        }
        if (incoming) {
          const index = state.records.findIndex((r) => r.id === incoming.id);
          if (index >= 0) state.records[index] = incoming;
          else state.records.push(incoming);
          byId.set(incoming.id, incoming);
        } else if (change.op === 'delete' && current) {
          const dead = { ...current, deletedAt: change.at || Date.now(), status: 'archived' as const };
          state.records = state.records.map((r) => r.id === dead.id ? dead : r);
          byId.set(dead.id, dead);
        }
        state.seq += 1;
        state.changes.push({ ...change, seq: state.seq, deviceId: change.deviceId || 'unknown' });
        known.add(change.changeId);
        acceptedChangeIds.push(change.changeId);
      }

      const deviceId = changes[0]?.deviceId;
      if (deviceId) {
        const existing = state.devices.find((d) => d.deviceId === deviceId);
        if (existing) existing.lastSeenAt = Date.now();
        else state.devices.push({ deviceId, lastSeenAt: Date.now() });
      }
      if (acceptedChangeIds.length) {
        const written = await this.writeRemote(remote, state);
        if (!written.ok) {
          return {
            ok: false, acceptedChangeIds: [], cursor: 0, conflicts: [],
            error: written.conflict
              ? 'Google Drive memory changed on another device at the same time; retry sync'
              : (written.error ?? 'Google Drive write failed'),
          };
        }
      }
      return { ok: true, acceptedChangeIds, cursor: state.seq, conflicts };
    } catch (e: any) {
      return { ok: false, acceptedChangeIds: [], cursor: 0, conflicts: [], error: e?.message ?? 'Google Drive push failed' };
    }
  }

  async backup(tenantId: string): Promise<string | null> {
    try {
      const remote = await this.readRemote(tenantId);
      const name = `${BACKUP_PREFIX}${sanitize(tenantId)}-${Date.now()}.json`;
      await this.createFile(name, JSON.stringify(remote.state));
      return name;
    } catch { return null; }
  }

  async restoreSnapshot(tenantId: string): Promise<DriveState | null> {
    try {
      const files = (await this.fileList())
        .filter((f) => f.name.startsWith(`${BACKUP_PREFIX}${sanitize(tenantId)}-`) && f.name.endsWith('.json'))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!files.length) return null;
      const latest = files[files.length - 1];
      const downloaded = await this.download(latest.id);
      const parsed = normalizeState(JSON.parse(downloaded.text), tenantId);
      const remote = await this.readRemote(tenantId);
      const written = await this.writeRemote(remote, parsed);
      return written.ok ? parsed : null;
    } catch { return null; }
  }

  async restore(tenantId: string): Promise<boolean> {
    return !!(await this.restoreSnapshot(tenantId));
  }

  async putObject(tenantId: string, key: string, content: string): Promise<boolean> {
    try {
      const name = objectFileName(tenantId, key);
      const existing = await this.findFile(name);
      if (existing) {
        const etag = await this.fileEtag(existing.id);
        const result = await this.updateFile(existing.id, content, etag);
        return result.ok;
      }
      await this.createFile(name, content);
      return true;
    } catch { return false; }
  }

  async getObject(tenantId: string, key: string): Promise<string | null> {
    try {
      const existing = await this.findFile(objectFileName(tenantId, key));
      if (!existing) return null;
      return (await this.download(existing.id)).text;
    } catch { return null; }
  }

  async usage(tenantId: string): Promise<CloudUsage | null> {
    try {
      const remote = await this.readRemote(tenantId);
      const files = await this.fileList();
      let bytes = 0;
      for (const file of files) bytes += Number(file.size) || 0;
      let quotaUsed = 0;
      let quotaLimit = 0;
      let accountEmail = this.readCreds().email;
      try {
        const about = await this.json<any>('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota(limit,usage)');
        quotaUsed = Number(about?.storageQuota?.usage) || 0;
        quotaLimit = Number(about?.storageQuota?.limit) || 0;
        accountEmail = about?.user?.emailAddress || accountEmail;
      } catch { /* quota is optional */ }
      return {
        records: remote.state.records.length,
        changes: remote.state.changes.length,
        objects: files.filter((f) => f.name.startsWith(`${OBJECT_PREFIX}${sanitize(tenantId)}-`)).length,
        bytes,
        devices: remote.state.devices,
        accountEmail: accountEmail || undefined,
        quotaUsed,
        quotaLimit,
      };
    } catch { return null; }
  }

  async devices(tenantId: string): Promise<{ deviceId: string; lastSeenAt: number }[]> {
    try { return (await this.readRemote(tenantId)).state.devices; } catch { return []; }
  }

  async revokeDevice(tenantId: string, deviceId: string): Promise<boolean> {
    try {
      const remote = await this.readRemote(tenantId);
      remote.state.devices = remote.state.devices.filter((d) => d.deviceId !== deviceId);
      const written = await this.writeRemote(remote, remote.state);
      return written.ok;
    } catch { return false; }
  }

  async deleteTenantData(tenantId: string): Promise<boolean> {
    try {
      const prefix = `${STATE_PREFIX}${sanitize(tenantId)}`;
      const objectPrefix = `${OBJECT_PREFIX}${sanitize(tenantId)}-`;
      const backupPrefix = `${BACKUP_PREFIX}${sanitize(tenantId)}-`;
      const files = (await this.fileList()).filter((f) =>
        f.name === `${prefix}.json` || f.name.startsWith(objectPrefix) || f.name.startsWith(backupPrefix));
      let ok = true;
      for (const file of files) {
        if (!await this.deleteFile(file.id)) ok = false;
      }
      return ok;
    } catch { return false; }
  }
}
