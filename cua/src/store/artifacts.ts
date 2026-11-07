import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { CuaError } from '../protocol/errors.js';
import type { ArtifactRecord, SessionStore } from './store.js';
import { assertPathWithin } from '../agent/verifier.js';

export class ArtifactStore {
  readonly root: string;
  private store?: SessionStore;

  constructor(root: string, store?: SessionStore) {
    this.root = resolve(root);
    this.store = store;
  }

  async save(options: {
    taskId?: string;
    kind: string;
    bytes: Buffer;
    extension: string;
    meta?: Record<string, unknown>;
  }): Promise<ArtifactRecord> {
    const safeTask = (options.taskId ?? 'shared').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = join(this.root, safeTask);
    await mkdir(dir, { recursive: true });
    const ext = options.extension.startsWith('.') ? options.extension : `.${options.extension}`;
    const hash = createHash('sha256').update(options.bytes).digest('hex');
    const filename = `${Date.now()}-${hash.slice(0, 12)}${ext}`;
    const path = join(dir, filename);
    await writeFile(path, options.bytes, { mode: 0o600 });
    const meta = { ...(options.meta ?? {}), size: options.bytes.length };
    if (this.store) {
      return this.store.saveArtifact({
        taskId: options.taskId,
        kind: options.kind,
        path,
        sha256: hash,
        meta,
      });
    }
    return {
      id: `art_${hash.slice(0, 8)}`,
      taskId: options.taskId,
      kind: options.kind,
      path,
      sha256: hash,
      meta,
      createdAt: new Date().toISOString(),
    };
  }

  async readByPath(path: string): Promise<Buffer> {
    const resolved = assertPathWithin(path, [this.root]);
    return readFile(resolved);
  }

  async readById(id: string): Promise<{ record: ArtifactRecord; bytes: Buffer }> {
    if (!this.store) throw new CuaError('INTERNAL', 'Artifact store has no database.');
    const record = this.store.getArtifact(id);
    if (!record) throw new CuaError('TASK_NOT_FOUND', `Artifact ${id} does not exist.`);
    const resolved = assertPathWithin(record.path, [this.root]);
    return { record, bytes: await readFile(resolved) };
  }

  static mimeFor(path: string): string {
    switch (extname(path).toLowerCase()) {
      case '.png':
        return 'image/png';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.json':
        return 'application/json';
      case '.txt':
        return 'text/plain; charset=utf-8';
      case '.md':
        return 'text/markdown; charset=utf-8';
      default:
        return 'application/octet-stream';
    }
  }
}
