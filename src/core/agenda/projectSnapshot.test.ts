import { describe, expect, it } from 'vitest';
import { formatProjectSnapshot, readProjectSnapshot, type ProjectSnapshotFs } from './projectSnapshot';

interface FakeEntry {
  name: string;
  isDirectory?: boolean;
}

function fakeFs(
  dirs: Record<string, FakeEntry[]>,
  files: Record<string, string | null> = {}
): ProjectSnapshotFs {
  return {
    readDir: async (dirPath) => {
      const listing = dirs[dirPath];
      if (!listing) throw new Error(`ENOENT ${dirPath}`);
      return listing.map((entry) => ({
        ...entry,
        path: `${dirPath}/${entry.name}`,
      }));
    },
    readFile: async (filePath) => files[filePath] ?? null,
    join: (dirPath, name) => `${dirPath.replace(/\/+$/, '')}/${name}`,
  };
}

const packageJson = JSON.stringify({
  name: 'widgets',
  dependencies: { react: '^18.0.0', electron: '^42.0.0' },
  devDependencies: { vite: '^6.0.0', typescript: '^5.0.0' },
});

describe('project snapshot', () => {
  it('reads a bounded tree, manifests and README while ignoring vendor dirs', async () => {
    const fs = fakeFs(
      {
        '/proj': [
          { name: 'src', isDirectory: true },
          { name: 'node_modules', isDirectory: true },
          { name: 'dist', isDirectory: true },
          { name: 'package.json' },
          { name: 'tsconfig.json' },
          { name: 'README.md' },
        ],
        '/proj/src': [
          { name: 'components', isDirectory: true },
          { name: 'index.ts' },
        ],
        '/proj/src/components': [{ name: 'Button.tsx' }],
        '/proj/node_modules': [{ name: 'react' }],
      },
      {
        '/proj/package.json': packageJson,
        '/proj/tsconfig.json': '{"compilerOptions":{"jsx":"react-jsx"}}',
        '/proj/README.md': '# Widgets\n\nA desktop widget manager.',
      }
    );

    const snapshot = await readProjectSnapshot('/proj', fs);
    expect(snapshot.name).toBe('proj');
    expect(snapshot.fileCount).toBe(5);
    expect(snapshot.tree).toContain('src/components/Button.tsx');
    expect(snapshot.tree).not.toContain('node_modules/');
    expect(snapshot.tree).not.toContain('dist/');
    expect(snapshot.stack).toEqual(expect.arrayContaining(['Node.js', 'React', 'Electron', 'Vite', 'TypeScript']));
    expect(snapshot.manifests.map((entry) => entry.name)).toEqual(['package.json', 'tsconfig.json']);
    expect(snapshot.readme?.content).toContain('desktop widget manager');

    const text = formatProjectSnapshot(snapshot);
    expect(text).toContain('## Existing project snapshot');
    expect(text).toContain('Detected stack');
    expect(text).toContain('### package.json');
    expect(text).toContain('src/components/Button.tsx');
  });

  it('does not expand directories beyond the depth limit', async () => {
    const fs = fakeFs({
      '/proj': [{ name: 'src', isDirectory: true }],
      '/proj/src': [{ name: 'deep', isDirectory: true }],
      '/proj/src/deep': [{ name: 'nested', isDirectory: true }],
      '/proj/src/deep/nested': [{ name: 'hidden.ts' }],
    });
    const snapshot = await readProjectSnapshot('/proj', fs, { maxDepth: 1 });
    expect(snapshot.tree).toContain('src/deep/ (not expanded)');
    expect(snapshot.tree.join('\n')).not.toContain('hidden.ts');
  });

  it('truncates large trees and tolerates unreadable paths', async () => {
    const files = Array.from({ length: 300 }, (_, index) => ({ name: `file-${index}.ts` }));
    const fs = fakeFs({ '/proj': [...files, { name: 'locked', isDirectory: true }] });
    const snapshot = await readProjectSnapshot('/proj', fs, { maxEntries: 50 });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.tree.length).toBeLessThanOrEqual(50);
    expect(snapshot.notes).toContain('unreadable:locked');
  });

  it('caps the formatted prompt and marks truncation', async () => {
    const fs = fakeFs(
      { '/proj': [{ name: 'README.md' }] },
      { '/proj/README.md': 'x'.repeat(20000) }
    );
    const snapshot = await readProjectSnapshot('/proj', fs, { maxReadmeChars: 12000 });
    const text = formatProjectSnapshot(snapshot, 3000);
    expect(text.length).toBeLessThanOrEqual(3010);
    expect(text).toContain('项目快照已截断');
  });
});

describe('project snapshot resilience', () => {
  it('keeps going when a manifest cannot be read', async () => {
    const fs = {
      readDir: async (dirPath: string) =>
        dirPath === '/proj'
          ? [
              { name: 'package.json' },
              { name: 'README.md' },
            ]
          : [],
      readFile: async (filePath: string) => {
        if (filePath.endsWith('package.json')) throw new Error('EACCES');
        return '# Readme';
      },
      join: (dirPath: string, name: string) => `${dirPath}/${name}`,
    };
    const snapshot = await readProjectSnapshot('/proj', fs);
    expect(snapshot.notes).toContain('unreadable:package.json');
    expect(snapshot.readme?.content).toContain('Readme');
  });
});
