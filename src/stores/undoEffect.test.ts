import { describe, it, expect, beforeEach } from 'vitest';
import { undoEffect } from './codeChanges.store';
import type { CodeChange } from './codeChanges.store';

// In-memory filesystem standing in for the preload bridge, so the undo rules can
// be exercised without touching disk.
let files: Map<string, string>;

function installFsStub() {
  files = new Map();
  (globalThis as any).window = {
    electronAPI: {
      fs: {
        readFile: async (p: string) => (files.has(p) ? files.get(p)! : null),
        writeFile: async (p: string, c: string) => { files.set(p, c); return true; },
        exists: async (p: string) => files.has(p),
        deleteFile: async (p: string) => files.delete(p),
        createDir: async () => true,
        rename: async (from: string, to: string) => {
          if (!files.has(from)) return false;
          files.set(to, files.get(from)!);
          files.delete(from);
          return true;
        },
      },
    },
  };
}

const change = (c: Partial<CodeChange>): CodeChange => ({
  id: 'c1', kind: 'edit', filePath: '/a.ts', originalCode: '', newCode: '',
  description: '', status: 'applied', createdAt: 0, ...c,
} as CodeChange);

describe('undoEffect', () => {
  beforeEach(installFsStub);

  describe('edit', () => {
    it('restores the original content', async () => {
      files.set('/a.ts', 'new\n');
      const r = await undoEffect(change({ kind: 'edit', originalCode: 'old\n', newCode: 'new\n' }));
      expect(r.success).toBe(true);
      expect(files.get('/a.ts')).toBe('old\n');
    });

    it('refuses when the edited lines changed again', async () => {
      files.set('/a.ts', 'something else entirely\n');
      const r = await undoEffect(change({ kind: 'edit', originalCode: 'old\n', newCode: 'new\n' }));
      expect(r.success).toBe(false);
      expect(r.error).toContain('manually');
      expect(files.get('/a.ts')).toBe('something else entirely\n'); // untouched
    });

    it('is a no-op when the file is already back to the original', async () => {
      files.set('/a.ts', 'old\n');
      const r = await undoEffect(change({ kind: 'edit', originalCode: 'old\n', newCode: 'new\n' }));
      expect(r.success).toBe(true);
    });
  });

  describe('create', () => {
    it('deletes the file it created', async () => {
      files.set('/new.ts', 'body');
      const r = await undoEffect(change({ kind: 'create', filePath: '/new.ts', newCode: 'body' }));
      expect(r.success).toBe(true);
      expect(files.has('/new.ts')).toBe(false);
    });

    it('keeps a created file that was edited afterwards', async () => {
      files.set('/new.ts', 'body + my own work');
      const r = await undoEffect(change({ kind: 'create', filePath: '/new.ts', newCode: 'body' }));
      expect(r.success).toBe(false);
      expect(files.has('/new.ts')).toBe(true);
    });

    it('succeeds silently when the file is already gone', async () => {
      const r = await undoEffect(change({ kind: 'create', filePath: '/gone.ts', newCode: 'x' }));
      expect(r.success).toBe(true);
    });
  });

  describe('delete', () => {
    it('restores the deleted file from the captured content', async () => {
      const r = await undoEffect(change({ kind: 'delete', filePath: '/d.ts', originalCode: 'saved content' }));
      expect(r.success).toBe(true);
      expect(files.get('/d.ts')).toBe('saved content');
    });

    it('never overwrites a file that exists again', async () => {
      files.set('/d.ts', 'recreated by the user');
      const r = await undoEffect(change({ kind: 'delete', filePath: '/d.ts', originalCode: 'saved content' }));
      expect(r.success).toBe(false);
      expect(files.get('/d.ts')).toBe('recreated by the user');
    });

    it('reports that a deleted folder\'s contents cannot come back', async () => {
      const r = await undoEffect(change({ kind: 'delete', filePath: '/dir', originalCode: '[Directory]' }));
      expect(r.success).toBe(false);
      expect(r.error).toContain('contents');
    });
  });

  describe('rename', () => {
    it('renames the file back', async () => {
      files.set('/new-name.ts', 'x');
      const r = await undoEffect(change({ kind: 'rename', filePath: '/old-name.ts', newCode: 'Rename to: /new-name.ts' }));
      expect(r.success).toBe(true);
      expect(files.has('/old-name.ts')).toBe(true);
      expect(files.has('/new-name.ts')).toBe(false);
    });

    it('refuses when the renamed file is gone', async () => {
      const r = await undoEffect(change({ kind: 'rename', filePath: '/old.ts', newCode: 'Rename to: /new.ts' }));
      expect(r.success).toBe(false);
    });

    it('refuses to clobber a file back at the old path', async () => {
      files.set('/new.ts', 'x');
      files.set('/old.ts', 'something new here');
      const r = await undoEffect(change({ kind: 'rename', filePath: '/old.ts', newCode: 'Rename to: /new.ts' }));
      expect(r.success).toBe(false);
      expect(files.get('/old.ts')).toBe('something new here');
    });
  });

  describe('copy', () => {
    it('deletes the copy', async () => {
      files.set('/src.ts', 'same');
      files.set('/dst.ts', 'same');
      const r = await undoEffect(change({ kind: 'copy', filePath: '/src.ts', newCode: 'Copy to: /dst.ts' }));
      expect(r.success).toBe(true);
      expect(files.has('/dst.ts')).toBe(false);
      expect(files.has('/src.ts')).toBe(true); // the source is never touched
    });

    it('keeps the copy once it has diverged from the source', async () => {
      files.set('/src.ts', 'same');
      files.set('/dst.ts', 'edited since the copy');
      const r = await undoEffect(change({ kind: 'copy', filePath: '/src.ts', newCode: 'Copy to: /dst.ts' }));
      expect(r.success).toBe(false);
      expect(files.has('/dst.ts')).toBe(true);
    });
  });

  describe('exec', () => {
    it('reports that a command cannot be undone', async () => {
      const r = await undoEffect(change({ kind: 'exec', filePath: '[Command]', newCode: 'rm -rf build' }));
      expect(r.success).toBe(false);
      expect(r.error).toContain("can't be reverted");
    });
  });
});
