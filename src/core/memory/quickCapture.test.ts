import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseQuickCapture, captureMemory } from './quickCapture';
import { MEMORY_HEADING, type MemoryFile } from './memoryFiles';

// captureMemory takes its file access as arguments, so this drives it against
// real files on a real disk — the unit tests prove the string transform, this
// proves the whole write actually lands.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-capture-'));
let home: string;
let root: string;
let seq = 0;

const io = {
  readFile: async (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null),
  writeFile: async (p: string, content: string) => { fs.writeFileSync(p, content); return true; },
  createDir: async (p: string) => { fs.mkdirSync(p, { recursive: true }); return true; },
};

beforeEach(() => {
  seq += 1;
  home = path.join(tmp, `home${seq}`);
  root = path.join(tmp, `repo${seq}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('parseQuickCapture', () => {
  it('takes the rest of the line after "# "', () => {
    expect(parseQuickCapture('# always run the tests')).toBe('always run the tests');
    expect(parseQuickCapture('#   padded   ')).toBe('padded');
  });

  it('keeps a multi-line capture whole', () => {
    expect(parseQuickCapture('# first line\nsecond line')).toBe('first line\nsecond line');
  });

  it('leaves ordinary messages alone', () => {
    expect(parseQuickCapture('what does # mean')).toBeNull();
    expect(parseQuickCapture('')).toBeNull();
    expect(parseQuickCapture('#')).toBeNull();
  });

  it('does not hijack a markdown heading the user is actually writing', () => {
    // Exactly one "#" then a space. "##" is a heading someone typed on purpose,
    // and silently turning it into a stored rule would be worse than useless.
    expect(parseQuickCapture('## a markdown heading')).toBeNull();
    expect(parseQuickCapture('### notes')).toBeNull();
  });

  it('does not swallow an issue number or a tag', () => {
    // No space after the # — that is a reference, not an instruction.
    expect(parseQuickCapture('#1234 is still broken')).toBeNull();
    expect(parseQuickCapture('#urgent fix the build')).toBeNull();
  });
});

describe('captureMemory', () => {
  it('creates the user file, and the ~/.conecode directory it needs', async () => {
    const result = await captureMemory({ text: 'Answer in Chinese', scope: 'user', homeDir: home, ...io });

    expect(result.ok).toBe(true);
    const written = fs.readFileSync(path.join(home, '.conecode/CLAUDE.md'), 'utf-8');
    expect(written).toBe(`${MEMORY_HEADING}\n\n- Answer in Chinese\n`);
  });

  it('creates the project file next to the code', async () => {
    const result = await captureMemory({ text: 'Use pnpm', scope: 'project', homeDir: home, rootPath: root, ...io });

    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(root, 'CLAUDE.md'));
    expect(fs.readFileSync(result.path!, 'utf-8')).toContain('- Use pnpm');
  });

  it('appends to a hand-written file without disturbing it', async () => {
    const file = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(file, '# My project\n\nSome notes the human wrote.\n');

    await captureMemory({ text: 'Use pnpm', scope: 'project', homeDir: home, rootPath: root, ...io });

    const written = fs.readFileSync(file, 'utf-8');
    expect(written).toContain('Some notes the human wrote.');
    expect(written).toContain('- Use pnpm');
    expect(written.indexOf('Some notes')).toBeLessThan(written.indexOf('- Use pnpm'));
  });

  it('writes to the file the repo already uses instead of starting a rival one', async () => {
    const agents = path.join(root, 'AGENTS.md');
    fs.writeFileSync(agents, 'existing rules\n');
    const existing: MemoryFile[] = [{ path: agents, scope: 'project', content: 'existing rules' }];

    const result = await captureMemory({ text: 'Use pnpm', scope: 'project', homeDir: home, rootPath: root, existing, ...io });

    expect(result.path).toBe(agents);
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(fs.readFileSync(agents, 'utf-8')).toContain('- Use pnpm');
  });

  it('records the same rule once, however many times it is captured', async () => {
    const args = { text: 'Use pnpm', scope: 'project' as const, homeDir: home, rootPath: root, ...io };
    await captureMemory(args);
    const second = await captureMemory({ ...args, text: '  use PNPM  ' });

    expect(second.ok).toBe(true);
    expect(second.message).toContain('Already remembered');
    const written = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8');
    expect(written.match(/use pnpm/gi)).toHaveLength(1);
  });

  it('keeps several rules in one section', async () => {
    const args = { scope: 'project' as const, homeDir: home, rootPath: root, ...io };
    await captureMemory({ ...args, text: 'First rule' });
    await captureMemory({ ...args, text: 'Second rule' });
    await captureMemory({ ...args, text: 'Third rule' });

    const written = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8');
    expect(written).toBe(`${MEMORY_HEADING}\n\n- First rule\n- Second rule\n- Third rule\n`);
  });

  it('refuses a project memory when no folder is open, rather than writing somewhere odd', async () => {
    const result = await captureMemory({ text: 'Use pnpm', scope: 'project', homeDir: home, ...io });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('No folder is open');
  });

  it('reports a failed write instead of claiming success', async () => {
    const result = await captureMemory({
      text: 'Use pnpm', scope: 'project', homeDir: home, rootPath: root,
      ...io,
      writeFile: async () => false,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Could not write');
  });
});
