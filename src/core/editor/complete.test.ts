import { describe, expect, it } from 'vitest';
import {
  suggestContext, candidates, filterCompletions, wordsIn,
  snippetsFor, keywordsFor, pathCompletions, flattenPaths, splitInsert,
} from './complete';

describe('suggestContext', () => {
  it('offers word completion on a fragment', () => {
    expect(suggestContext('cons', 4)).toEqual({ mode: 'word', prefix: 'cons', replaceStart: 0 });
    expect(suggestContext('  ret', 5)).toEqual({ mode: 'word', prefix: 'ret', replaceStart: 2 });
  });

  it('offers members after a dot', () => {
    expect(suggestContext('foo.', 4)).toEqual({ mode: 'property', prefix: '', replaceStart: 4 });
    expect(suggestContext('foo.bar', 7)?.mode).toBe('word');
  });

  it('offers paths inside strings', () => {
    const ctx = suggestContext("import x from './ut", 19);
    expect(ctx?.mode).toBe('path');
    expect(ctx?.prefix).toBe('ut');
    const bare = suggestContext("from '", 6);
    expect(bare?.mode).toBe('path');
  });

  it('stays quiet outside identifiers', () => {
    expect(suggestContext('foo();', 5)).toBeNull();
    expect(suggestContext('', 0)).toBeNull();
    expect(suggestContext('  ', 2)).toBeNull();
  });
});

describe('candidates', () => {
  it('mixes snippets, keywords and document words', () => {
    const items = candidates(
      { mode: 'word', prefix: 'con', replaceStart: 0 },
      { lang: 'typescript', doc: 'const config = connect();' },
    );
    const labels = items.map((i) => i.label);
    expect(labels).toContain('const');
    expect(labels).toContain('config');
  });

  it('offers only words as members', () => {
    const items = candidates(
      { mode: 'property', prefix: '', replaceStart: 3 },
      { lang: 'typescript', doc: 'client.connect(); client.close();' },
    );
    expect(items.every((i) => i.kind === 'property')).toBe(true);
    expect(items.map((i) => i.label)).toContain('connect');
  });

  it('completes sibling paths', () => {
    const items = candidates(
      { mode: 'path', prefix: 'ut', replaceStart: 0, segment: 'ut' },
      { lang: 'typescript', doc: '', files: ['src/util.ts', 'src/main.ts', 'src/ui/box.ts'], currentDir: 'src' },
    );
    expect(items.map((i) => i.label)).toContain('util.ts');
    expect(items.map((i) => i.label)).toContain('../');
  });
});

describe('filterCompletions', () => {
  it('ranks exact, prefix, then fuzzy', () => {
    const items = [
      { label: 'connect', kind: 'word' as const, insert: 'connect' },
      { label: 'con', kind: 'keyword' as const, insert: 'con' },
      { label: 'reconnect', kind: 'word' as const, insert: 'reconnect' },
    ];
    const out = filterCompletions(items, 'con').map((i) => i.label);
    expect(out[0]).toBe('con');
    expect(out).toContain('connect');
  });

  it('prefers snippets over plain words', () => {
    const items = [
      { label: 'for', kind: 'word' as const, insert: 'for' },
      { label: 'for', kind: 'snippet' as const, insert: 'for', detail: 'for loop' },
    ];
    expect(filterCompletions(items, 'for')[0].kind).toBe('snippet');
  });

  it('drops non-matches', () => {
    const items = [{ label: 'apple', kind: 'word' as const, insert: 'apple' }];
    expect(filterCompletions(items, 'zzz')).toEqual([]);
  });
});

describe('wordsIn / snippetsFor / keywordsFor', () => {
  it('harvests frequent identifiers, skipping the typed word', () => {
    const out = wordsIn('connect(); connect(); xyz();', 'con');
    expect(out[0].label).toBe('connect');
    expect(out.map((i) => i.label)).not.toContain('con');
  });

  it('knows snippets and keywords per family', () => {
    expect(snippetsFor('typescript').map((s) => s.label)).toContain('clg');
    expect(snippetsFor('python').map((s) => s.label)).toContain('def');
    expect(keywordsFor('json').map((k) => k.label)).toContain('null');
    expect(keywordsFor('unknownlang')).toEqual([]);
  });
});

describe('flattenPaths / splitInsert', () => {
  it('flattens a tree to relative paths', () => {
    const paths = flattenPaths([
      { path: '/root/src', isDirectory: true, children: [{ path: '/root/src/a.ts', isDirectory: false }] },
      { path: '/root/README.md', isDirectory: false },
    ], '/root');
    expect(paths).toEqual(['src/', 'src/a.ts', 'README.md']);
  });

  it('splits the caret marker', () => {
    expect(splitInsert('a|b')).toEqual({ text: 'ab', cursorOffset: 1 });
    expect(splitInsert('ab')).toEqual({ text: 'ab', cursorOffset: 2 });
  });

  it('does not offer the segment itself as a completion', () => {
    const items = pathCompletions(['src/util.ts'], 'src', 'util.ts');
    expect(items.map((i) => i.label)).not.toContain('util.ts');
  });
});
