import { describe, it, expect, afterAll } from 'vitest';
import {
  memoryFileCandidates, selectExistingFiles, targetFileFor, appendMemoryLine, formatMemoryFiles,
  MEMORY_HEADING, MAX_ANCESTOR_DEPTH,
  type MemoryFile,
} from './memoryFiles';

const HOME = '/Users/dev';

describe('memoryFileCandidates', () => {
  it('always offers the user file, even with no project open', () => {
    const paths = memoryFileCandidates({ homeDir: HOME }).map((f) => f.path);
    expect(paths).toEqual(['/Users/dev/.conecode/CLAUDE.md']);
  });

  it('orders furthest-first so the nearest file is read last', () => {
    const files = memoryFileCandidates({ homeDir: HOME, rootPath: '/Users/dev/work/repo' });
    expect(files[0].scope).toBe('user');
    expect(files[files.length - 1].scope).toBe('project');
    // The ancestor's own memory must come before the project's.
    const firstAncestor = files.findIndex((f) => f.scope === 'ancestor');
    const firstProject = files.findIndex((f) => f.scope === 'project');
    expect(firstAncestor).toBeLessThan(firstProject);
  });

  it('offers every recognised filename in the project directory', () => {
    const project = memoryFileCandidates({ homeDir: HOME, rootPath: '/Users/dev/repo' })
      .filter((f) => f.scope === 'project')
      .map((f) => f.path);
    expect(project).toEqual([
      '/Users/dev/repo/CLAUDE.md',
      '/Users/dev/repo/AGENTS.md',
      '/Users/dev/repo/.conecode/AGENTS.md',
    ]);
  });

  it('lets a monorepo root reach the package nested inside it', () => {
    const paths = memoryFileCandidates({ homeDir: HOME, rootPath: '/Users/dev/mono/packages/web' })
      .filter((f) => f.scope === 'ancestor')
      .map((f) => f.path);
    expect(paths).toContain('/Users/dev/mono/CLAUDE.md');
    expect(paths).toContain('/Users/dev/mono/packages/CLAUDE.md');
    // Outermost first.
    expect(paths.indexOf('/Users/dev/mono/CLAUDE.md')).toBeLessThan(paths.indexOf('/Users/dev/mono/packages/CLAUDE.md'));
  });

  it('stops at the home directory rather than trawling the whole disk', () => {
    const paths = memoryFileCandidates({ homeDir: HOME, rootPath: '/Users/dev/repo' }).map((f) => f.path);
    expect(paths.some((p) => p === '/Users/dev/CLAUDE.md')).toBe(false);
    expect(paths.some((p) => p.startsWith('/Users/CLAUDE'))).toBe(false);
  });

  it('bounds how far up it will look', () => {
    const deep = '/srv/a/b/c/d/e/f/g/project';
    const ancestors = new Set(
      memoryFileCandidates({ homeDir: HOME, rootPath: deep })
        .filter((f) => f.scope === 'ancestor')
        // Each ancestor contributes several filenames, one of them nested in
        // .conecode/ — count the directories they belong to, not the paths.
        .map((f) => f.path.replace(/\/(?:\.conecode\/)?[^/]+$/, '')),
    );
    expect(ancestors.size).toBe(MAX_ANCESTOR_DEPTH);
    expect(ancestors.has('/srv/a/b/c/d/e/f/g')).toBe(true);
    expect(ancestors.has('/srv/a')).toBe(false);
  });

  it('is not confused by a trailing slash on the project path', () => {
    const withSlash = memoryFileCandidates({ homeDir: HOME, rootPath: '/Users/dev/repo/' }).map((f) => f.path);
    const without = memoryFileCandidates({ homeDir: HOME, rootPath: '/Users/dev/repo' }).map((f) => f.path);
    expect(withSlash).toEqual(without);
  });
});

describe('selectExistingFiles', () => {
  const file = (path: string, scope: MemoryFile['scope'], content: string | null): MemoryFile =>
    ({ path, scope, content });

  it('keeps only the files that have something in them', () => {
    const out = selectExistingFiles([
      file('/a/CLAUDE.md', 'project', null),
      file('/a/AGENTS.md', 'project', '   '),
      file('/b/CLAUDE.md', 'project', 'real rules'),
    ]);
    expect(out.map((f) => f.path)).toEqual(['/b/CLAUDE.md']);
  });

  it('takes only the first memory file in any one directory', () => {
    // A repo with both means one is the real one; loading both would say
    // everything twice.
    const out = selectExistingFiles([
      file('/repo/CLAUDE.md', 'project', 'claude rules'),
      file('/repo/AGENTS.md', 'project', 'agents rules'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('/repo/CLAUDE.md');
  });

  it('treats .conecode/AGENTS.md as belonging to its project directory', () => {
    const out = selectExistingFiles([
      file('/repo/CLAUDE.md', 'project', 'claude rules'),
      file('/repo/.conecode/AGENTS.md', 'project', 'nested rules'),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps one file per directory across the hierarchy', () => {
    const out = selectExistingFiles([
      file('/Users/dev/.conecode/CLAUDE.md', 'user', 'personal'),
      file('/mono/CLAUDE.md', 'ancestor', 'monorepo'),
      file('/mono/pkg/CLAUDE.md', 'project', 'package'),
    ]);
    expect(out.map((f) => f.scope)).toEqual(['user', 'ancestor', 'project']);
  });
});

describe('targetFileFor', () => {
  it('writes personal memory to the user file', () => {
    expect(targetFileFor('user', { homeDir: HOME })).toBe('/Users/dev/.conecode/CLAUDE.md');
  });

  it('creates CLAUDE.md when the repo has no memory file yet', () => {
    expect(targetFileFor('project', { homeDir: HOME, rootPath: '/repo' })).toBe('/repo/CLAUDE.md');
  });

  it('writes to the file the repo already uses instead of starting a rival one', () => {
    const existing: MemoryFile[] = [{ path: '/repo/AGENTS.md', scope: 'project', content: 'rules' }];
    expect(targetFileFor('project', { homeDir: HOME, rootPath: '/repo', existing })).toBe('/repo/AGENTS.md');
  });

  it('refuses a project memory when no project is open', () => {
    expect(targetFileFor('project', { homeDir: HOME })).toBeNull();
  });
});

describe('appendMemoryLine', () => {
  it('starts the section in an empty file', () => {
    expect(appendMemoryLine(null, 'Always run the tests')).toBe(`${MEMORY_HEADING}\n\n- Always run the tests\n`);
  });

  it('adds its section without disturbing what the human wrote', () => {
    const out = appendMemoryLine('# My project\n\nSome notes.\n', 'Use pnpm');
    expect(out).toBe('# My project\n\nSome notes.\n\n## Memory\n\n- Use pnpm\n');
  });

  it('appends into the section that is already there', () => {
    const existing = `${MEMORY_HEADING}\n\n- First rule\n`;
    expect(appendMemoryLine(existing, 'Second rule')).toBe(`${MEMORY_HEADING}\n\n- First rule\n- Second rule\n`);
  });

  it('stays inside its own section instead of leaking into the next one', () => {
    const existing = [
      '# Title', '', MEMORY_HEADING, '', '- First rule', '', '## Build', '', 'Run npm build', '',
    ].join('\n');
    const out = appendMemoryLine(existing, 'Second rule')!;
    const lines = out.split('\n');
    expect(lines.indexOf('- Second rule')).toBeLessThan(lines.indexOf('## Build'));
    expect(lines.indexOf('- Second rule')).toBeGreaterThan(lines.indexOf('- First rule'));
    expect(out).toContain('Run npm build');
  });

  it('refuses to write the same rule twice', () => {
    const existing = `${MEMORY_HEADING}\n\n- Always run the tests\n`;
    expect(appendMemoryLine(existing, 'Always run the tests')).toBeNull();
    // …however it was punctuated or spaced.
    expect(appendMemoryLine(existing, '  always  run the TESTS  ')).toBeNull();
  });

  it('does not double the bullet when the caller already wrote one', () => {
    expect(appendMemoryLine(null, '- Already bulleted')).toBe(`${MEMORY_HEADING}\n\n- Already bulleted\n`);
  });

  it('rejects an empty line rather than writing a bare dash', () => {
    expect(appendMemoryLine(null, '   ')).toBeNull();
    expect(appendMemoryLine('# Notes\n', '-')).toBeNull();
  });

  it('finds the heading whatever its casing', () => {
    const out = appendMemoryLine('## MEMORY\n\n- One\n', 'Two')!;
    expect(out).toContain('- One\n- Two');
    expect(out).not.toContain('## Memory\n\n- Two');
  });
});

describe('formatMemoryFiles', () => {
  it('says nothing when no file has content', () => {
    expect(formatMemoryFiles([])).toBe('');
    expect(formatMemoryFiles([{ path: '/a/CLAUDE.md', scope: 'project', content: '  ' }])).toBe('');
  });

  it('labels each file by where it came from, nearest last', () => {
    const block = formatMemoryFiles([
      { path: '/Users/dev/.conecode/CLAUDE.md', scope: 'user', content: 'Answer in Chinese' },
      { path: '/mono/CLAUDE.md', scope: 'ancestor', content: 'Monorepo rules' },
      { path: '/mono/pkg/CLAUDE.md', scope: 'project', content: 'Package rules' },
    ]);
    expect(block.indexOf('every project')).toBeLessThan(block.indexOf('Inherited from /mono/CLAUDE.md'));
    expect(block.indexOf('Inherited from')).toBeLessThan(block.indexOf('This project (/mono/pkg/CLAUDE.md)'));
    expect(block).toContain('Later sections are more specific');
  });
});

// ---- against a real directory tree -----------------------------------------
// The tests above use synthetic paths. This one builds an actual monorepo on
// disk and runs the whole chain — candidates, read, select, format — because a
// wiring mistake between those steps would pass every unit test above.
describe('the whole chain, on a real filesystem', () => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');

  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'conecode-memfiles-'));
  const home = nodePath.join(tmp, 'home');
  const mono = nodePath.join(tmp, 'home', 'work', 'mono');
  const pkg = nodePath.join(mono, 'packages', 'web');

  const write = (p: string, body: string) => {
    fs.mkdirSync(nodePath.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  write(nodePath.join(home, '.conecode/CLAUDE.md'), '- Answer in Chinese\n');
  write(nodePath.join(mono, 'CLAUDE.md'), '- Monorepo: never edit generated files\n');
  write(nodePath.join(pkg, 'AGENTS.md'), '- Web package: Tailwind only\n');
  // A decoy: the same directory also has a CLAUDE.md, which must win over AGENTS.md.
  write(nodePath.join(pkg, 'CLAUDE.md'), '- Web package: use CLAUDE.md\n');

  const loaded = selectExistingFiles(
    memoryFileCandidates({ homeDir: home, rootPath: pkg }).map((file) => ({
      ...file,
      content: fs.existsSync(file.path) ? fs.readFileSync(file.path, 'utf-8') : null,
    })),
  );

  it('finds one file per level of the hierarchy', () => {
    expect(loaded.map((f) => f.scope)).toEqual(['user', 'ancestor', 'project']);
  });

  it('prefers CLAUDE.md over AGENTS.md in the same directory', () => {
    const project = loaded.find((f) => f.scope === 'project')!;
    expect(project.path).toBe(nodePath.join(pkg, 'CLAUDE.md'));
    expect(project.content).toContain('use CLAUDE.md');
  });

  it('inherits the monorepo root from two levels up', () => {
    expect(loaded.find((f) => f.scope === 'ancestor')?.path).toBe(nodePath.join(mono, 'CLAUDE.md'));
  });

  it('renders a prompt block with the nearest file last', () => {
    const block = formatMemoryFiles(loaded);
    expect(block.indexOf('Answer in Chinese')).toBeLessThan(block.indexOf('never edit generated files'));
    expect(block.indexOf('never edit generated files')).toBeLessThan(block.indexOf('use CLAUDE.md'));
    // The decoy must not be in there twice.
    expect(block).not.toContain('Tailwind only');
  });

  it('appends into the real project file and reads back changed', () => {
    const target = targetFileFor('project', { homeDir: home, rootPath: pkg, existing: loaded })!;
    const updated = appendMemoryLine(fs.readFileSync(target, 'utf-8'), 'Run typecheck before pushing')!;
    fs.writeFileSync(target, updated);

    const reread = fs.readFileSync(target, 'utf-8');
    expect(reread).toContain('- Web package: use CLAUDE.md');
    expect(reread).toContain('- Run typecheck before pushing');
    // Writing it again changes nothing.
    expect(appendMemoryLine(reread, 'Run typecheck before pushing')).toBeNull();
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
});
