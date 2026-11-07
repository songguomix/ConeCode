// Main-process persistence for Memory 2.0.
//
// Plain Node/fs only — no `import { app } from 'electron'` at module load, so
// this file is unit-testable outside Electron (the caller supplies the data dir).
// Writes are atomic (temp file + rename) and a .bak copy is kept before any
// migration, unlike the legacy `memory.json` full overwrite.

import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { memoryFileCandidates, selectExistingFiles } from '../src/core/memory/memoryFiles';
import { emptyState, type Memory2Bridge } from '../src/core/memory/v2/storage/interface';
import { normalizeRecord } from '../src/core/memory/v2/model';
import type { Memory2State } from '../src/core/memory/v2/types';

const STATE_FILE = 'memory2.json';
const BACKUP_FILE = 'memory2.backup.json';
const DEVICE_FILE = 'memory2.device.json';
const OBJECTS_DIR = 'objects';
const PROJECT_MARKER = '.conecode/memory-project.json';
const SECRET_PREFIX = 'enc:v1:';

/** Injected by Electron's safeStorage; absent in unit tests and plain Node. */
export interface Memory2SecretCodec {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

export class FileMemory2Store {
  constructor(
    private dataDir: string,
    private homeDir: string,
    private secrets?: Memory2SecretCodec,
  ) {}

  private ensure(): string {
    fs.mkdirSync(this.dataDir, { recursive: true });
    return this.dataDir;
  }

  private file(name: string): string { return path.join(this.ensure(), name); }

  /** Atomic write: never leave a half-written JSON after a crash. */
  private atomicWrite(target: string, data: unknown): boolean {
    try {
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, target);
      return true;
    } catch { return false; }
  }

  private readJSON<T>(name: string, fallback: T): T {
    try {
      const p = this.file(name);
      if (!fs.existsSync(p)) return fallback;
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
    } catch { return fallback; }
  }

  private decodeSecret(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith(SECRET_PREFIX)) return typeof value === 'string' ? value : '';
    if (!this.secrets) return '';
    try { return this.secrets.decrypt(value.slice(SECRET_PREFIX.length)); } catch { return ''; }
  }

  private encodeSecret(value: unknown): string {
    if (typeof value !== 'string' || !value) return '';
    // When a codec is available, a failure must fail the save rather than
    // silently discarding the user's token/passphrase.
    if (!this.secrets) return value;
    return `${SECRET_PREFIX}${this.secrets.encrypt(value)}`;
  }

  load(): Memory2State {
    const raw = this.readJSON<any>(STATE_FILE, null);
    if (!raw || raw.schema !== 2) return emptyState();
    const base = emptyState();
    const cloud = { ...base.cloud, ...(raw.cloud ?? {}) };
    // Credentials are encrypted with the OS keychain (safeStorage) when the
    // main process supplies a codec. A file copied to another machine cannot
    // be decrypted there — the user must re-enter the token.
    cloud.authToken = this.decodeSecret(cloud.authToken);
    cloud.e2ePassphrase = this.decodeSecret(cloud.e2ePassphrase);
    return {
      ...base,
      ...raw,
      records: Array.isArray(raw.records)
        ? raw.records.map(normalizeRecord).filter((r: any): r is NonNullable<typeof r> => !!r)
        : [],
      changes: Array.isArray(raw.changes) ? raw.changes : [],
      sync: { ...base.sync, ...(raw.sync ?? {}) },
      cloud,
      migration: { ...base.migration, ...(raw.migration ?? {}) },
      settings: { ...base.settings, ...(raw.settings ?? {}) },
    };
  }

  save(state: Memory2State): boolean {
    const onDisk = typeof structuredClone === 'function'
      ? structuredClone(state)
      : JSON.parse(JSON.stringify(state)) as Memory2State;
    onDisk.cloud.authToken = this.encodeSecret(state.cloud.authToken);
    onDisk.cloud.e2ePassphrase = this.encodeSecret(state.cloud.e2ePassphrase);
    return this.atomicWrite(this.file(STATE_FILE), onDisk);
  }

  backup(): { ok: boolean; path?: string } {
    try {
      const src = this.file(STATE_FILE);
      const dest = this.file(BACKUP_FILE);
      if (fs.existsSync(src)) fs.copyFileSync(src, dest);
      else fs.writeFileSync(dest, JSON.stringify(emptyState(), null, 2), 'utf-8');
      // Snapshot the legacy file too — migration must never risk old data.
      const legacy = path.join(this.dataDir, '..', 'memory.json');
      if (fs.existsSync(legacy)) fs.copyFileSync(legacy, this.file('memory.json.pre-memory2.bak'));
      return { ok: true, path: dest };
    } catch { return { ok: false }; }
  }

  restore(): { ok: boolean; state?: Memory2State } {
    try {
      const p = this.file(BACKUP_FILE);
      if (!fs.existsSync(p)) return { ok: false };
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (parsed?.schema !== 2) return { ok: false };
      this.atomicWrite(this.file(STATE_FILE), parsed);
      return { ok: true, state: this.load() };
    } catch { return { ok: false }; }
  }

  deviceId(): string {
    const existing = this.readJSON<{ id?: string }>(DEVICE_FILE, {});
    if (existing.id) return existing.id;
    const id = randomUUID();
    this.atomicWrite(this.file(DEVICE_FILE), { id, createdAt: Date.now() });
    return id;
  }

  putObject(key: string, content: string): boolean {
    try {
      const safe = key.replace(/[^a-zA-Z0-9._/-]/g, '_');
      const target = path.join(this.ensure(), OBJECTS_DIR, safe);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, target);
      return true;
    } catch { return false; }
  }

  getObject(key: string): string | null {
    try {
      const safe = key.replace(/[^a-zA-Z0-9._/-]/g, '_');
      const target = path.join(this.ensure(), OBJECTS_DIR, safe);
      return fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null;
    } catch { return null; }
  }

  /**
   * Stable per-project identity.
   *
   * Priority:
   *  1. an explicit .conecode/memory-project.json marker (can be committed by
   *     a team that wants a shared id);
   *  2. the git `origin` remote, normalised — two clones on two machines map to
   *     the same project id, which is what makes project memory shareable;
   *  3. a deterministic hash of the absolute path (offline / non-git folders).
   *
   * The path fallback is intentionally last: it is stable on one machine but
   * not across machines, and that limitation is documented in the UI.
   */
  projectId(rootPath: string): string {
    try {
      const marker = path.join(rootPath, PROJECT_MARKER);
      if (fs.existsSync(marker)) {
        const parsed = JSON.parse(fs.readFileSync(marker, 'utf-8'));
        if (typeof parsed?.id === 'string' && parsed.id) return parsed.id;
      }
      const remote = this.gitRemote(rootPath);
      const identity = remote ? `git:${remote}` : `path:${rootPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`;
      const id = `proj-${createHash('sha1').update(identity).digest('hex').slice(0, 20)}`;
      try {
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, JSON.stringify({ id, identity, createdAt: Date.now() }, null, 2), 'utf-8');
      } catch { /* read-only workspace: the deterministic id still works */ }
      return id;
    } catch {
      return `proj-${path.basename(rootPath)}`;
    }
  }

  /** Normalise a git remote so https/ssh forms of the same repo agree. */
  private gitRemote(rootPath: string): string | null {
    try {
      const raw = execFileSync('git', ['-C', rootPath, 'remote', 'get-url', 'origin'], {
        encoding: 'utf-8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!raw) return null;
      let value = raw
        .replace(/^[a-z]+:\/\//i, '')       // strip https://, ssh://, git://
        .replace(/^[^@/]+@/, '')             // strip git@
        .replace(/:/g, '/')                  // scp-like host:path
        .replace(/\/+/g, '/')
        .replace(/\.git$/i, '')
        .replace(/\/+$/, '')
        .toLowerCase();
      // Drop credentials accidentally embedded in an https remote.
      value = value.replace(/^[^/]*@/, '');
      return value || null;
    } catch {
      return null;
    }
  }

  /**
   * Read legacy data WITHOUT modifying it. Returns the old memory.json entries
   * plus every effective CLAUDE.md / AGENTS.md file for the open project.
   */
  legacySnapshot(rootPath?: string | null): { entries: any[]; files: { path: string; scope: string; content: string }[] } {
    const legacyPath = path.join(this.dataDir, '..', 'memory.json');
    let entries: any[] = [];
    try {
      if (fs.existsSync(legacyPath)) {
        const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        if (Array.isArray(parsed)) entries = parsed;
      }
    } catch { /* unreadable legacy data is reported, never guessed */ }

    const files: { path: string; scope: string; content: string }[] = [];
    const candidates = memoryFileCandidates({ homeDir: this.homeDir, rootPath: rootPath ?? null });
    for (const candidate of candidates) {
      try {
        if (!fs.existsSync(candidate.path)) continue;
        const content = fs.readFileSync(candidate.path, 'utf-8');
        if (content.trim()) files.push({ path: candidate.path, scope: candidate.scope, content });
      } catch { /* skip unreadable file */ }
    }
    const selected = selectExistingFiles(files.map((f) => ({ ...f, scope: f.scope as any })));
    return { entries, files: selected.map((f) => ({ path: f.path, scope: f.scope, content: f.content ?? '' })) };
  }

  /** Convenience adapter matching the preload bridge shape. */
  bridge(getRoot: () => string | null): Memory2Bridge {
    return {
      load: async () => this.load(),
      save: async (state) => this.save(state),
      backup: async () => this.backup(),
      restore: async () => this.restore(),
      putObject: async (key, content) => this.putObject(key, content),
      getObject: async (key) => this.getObject(key),
      deviceId: async () => this.deviceId(),
      legacySnapshot: async () => this.legacySnapshot(getRoot()),
      projectId: async (rootPath) => this.projectId(rootPath),
    };
  }
}
