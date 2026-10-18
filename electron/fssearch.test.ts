import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { searchFiles, findFiles, globToRegExp, MAX_FILE_BYTES } from './fssearch';

// Real files on disk in a temp tree: the walk's value is in what it *skips*
// (dependency trees, caches, nested checkouts) and in the errors it returns,
// neither of which a mocked fs would exercise honestly.

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-fssearch-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeTree(name: string): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

describe('searchFiles', () => {
  it('returns file/line/text matches, case-insensitively', async () => {
    const root = makeTree('basic');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'const needle = 1;\nconst other = 2;\nNEEDLE again\n');

    const res = await searchFiles({ root, query: 'needle' });

    expect(res.capped).toBe(false);
    expect(res.matches).toEqual([
      { file: path.join(root, 'src', 'a.ts'), line: 1, text: 'const needle = 1;' },
      { file: path.join(root, 'src', 'a.ts'), line: 3, text: 'NEEDLE again' },
    ]);
  });

  it('supports regex mode', async () => {
    const root = makeTree('regex');
    fs.writeFileSync(path.join(root, 'a.txt'), 'foo1\nfoo2\nbar\n');

    const res = await searchFiles({ root, query: 'foo\\d', isRegex: true });

    expect(res.matches.map((m) => m.line)).toEqual([1, 2]);
  });

  it('rejects a broken regex instead of reporting "no matches"', async () => {
    const root = makeTree('badregex');
    fs.writeFileSync(path.join(root, 'a.txt'), 'foo[\n');

    await expect(searchFiles({ root, query: 'foo[', isRegex: true }))
      .rejects.toThrow(/invalid regular expression/i);
    // The same query as literal text still searches fine.
    const literal = await searchFiles({ root, query: 'foo[', isRegex: false });
    expect(literal.matches.length).toBe(1);
  });

  it('rejects a missing folder, a nonexistent path, and a file path', async () => {
    const root = makeTree('badroot');
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'x\n');

    await expect(searchFiles({ root: '', query: 'x' })).rejects.toThrow(/No folder is open/);
    await expect(searchFiles({ root: path.join(root, 'nope'), query: 'x' })).rejects.toThrow(/does not exist/);
    await expect(searchFiles({ root: file, query: 'x' })).rejects.toThrow(/not a directory/);
  });

  it('skips dependency trees, caches, and nested checkouts', async () => {
    const root = makeTree('ignores');
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(root, '.worktrees', 'old-copy', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'nested-repo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'needle hidden\n');
    fs.writeFileSync(path.join(root, '.worktrees', 'old-copy', 'src', 'app.ts'), 'needle stale\n');
    fs.writeFileSync(path.join(root, 'nested-repo', '.git'), 'gitdir: /elsewhere\n');
    fs.writeFileSync(path.join(root, 'nested-repo', 'lib.ts'), 'needle nested\n');
    fs.writeFileSync(path.join(root, 'src.ts'), 'needle real\n');

    const res = await searchFiles({ root, query: 'needle' });

    expect(res.matches.map((m) => path.relative(root, m.file))).toEqual(['src.ts']);
  });

  it('still searches a skipped directory when it is given as the root explicitly', async () => {
    const root = makeTree('escape-hatch');
    const copy = path.join(root, '.worktrees', 'old-copy');
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'app.ts'), 'needle in the old copy\n');

    const res = await searchFiles({ root: copy, query: 'needle' });

    expect(res.matches.length).toBe(1);
  });

  it('skips binary and oversized files', async () => {
    const root = makeTree('binary');
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from('needle\0binary'));
    fs.writeFileSync(path.join(root, 'big.txt'), ('needle\n' + 'x'.repeat(100)).padEnd(MAX_FILE_BYTES + 10, 'x'));
    fs.writeFileSync(path.join(root, 'real.txt'), 'needle here\n');

    const res = await searchFiles({ root, query: 'needle' });

    expect(res.matches.map((m) => path.basename(m.file))).toEqual(['real.txt']);
  });

  it('stops at maxResults and says the list was capped', async () => {
    const root = makeTree('cap');
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), 'needle\nneedle\nneedle\n');
    }

    const capped = await searchFiles({ root, query: 'needle', maxResults: 10 });
    expect(capped.matches.length).toBe(10);
    expect(capped.capped).toBe(true);

    const complete = await searchFiles({ root, query: 'needle' });
    expect(complete.matches.length).toBe(15);
    expect(complete.capped).toBe(false);
  });
});

describe('findFiles', () => {
  it('matches root-level files for **/* and keeps nested matches', async () => {
    const root = makeTree('glob');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'x.ts'), '');

    const res = await findFiles({ root, pattern: '**/*' });

    expect(res.files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort())
      .toEqual(['package.json', 'src/a.ts']);
  });

  it('lets **/ match zero folders too', async () => {
    const root = makeTree('glob-depth');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'a.ts'), '');
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');

    const res = await findFiles({ root, pattern: '**/a.ts' });

    expect(res.files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort())
      .toEqual(['a.ts', 'src/a.ts']);
  });

  it('skips nested checkouts and reports its cap', async () => {
    const root = makeTree('glob-ignores');
    fs.mkdirSync(path.join(root, 'nested-repo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'nested-repo', '.git'), 'gitdir: /elsewhere\n');
    fs.writeFileSync(path.join(root, 'nested-repo', 'lib.ts'), '');
    fs.writeFileSync(path.join(root, 'app.ts'), '');

    const res = await findFiles({ root, pattern: '**/*' });
    expect(res.files.map((f) => path.basename(f))).toEqual(['app.ts']);

    const capped = await findFiles({ root, pattern: '**/*', maxResults: 1 });
    expect(capped.files.length).toBe(1);
    expect(capped.capped).toBe(true);
  });
});

describe('globToRegExp', () => {
  it('handles **, *, and ? with the plain-glob expectations', () => {
    expect(globToRegExp('**/*').test('package.json')).toBe(true);
    expect(globToRegExp('**/*').test('src/a.ts')).toBe(true);
    expect(globToRegExp('**/*').test('src/deep/a.ts')).toBe(true);
    expect(globToRegExp('**/*').test('.gitignore')).toBe(true);
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false);
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true);
    // Dots are literals, not regex wildcards.
    expect(globToRegExp('a.ts').test('aXts')).toBe(false);
  });
});
