import { describe, expect, it } from 'vitest';
import {
  computeEnterEdit, autoClose, backspacePair, braceOutdent,
  toggleComment, duplicateLines, moveLines, deleteLines,
  wordAt, selectNextOccurrence,
} from './editOps';

describe('computeEnterEdit', () => {
  it('carries the current indent', () => {
    const r = computeEnterEdit('  foo();', 8);
    expect(r).toEqual({ text: '  foo();\n  ', cursor: 11 });
  });

  it('adds a level after an opener', () => {
    const r = computeEnterEdit('function f() {', 14);
    expect(r).toEqual({ text: 'function f() {\n  ', cursor: 17 });
  });

  it('splits a brace pair onto three lines', () => {
    const r = computeEnterEdit('  {}', 3);
    expect(r).toEqual({ text: '  {\n    \n  }', cursor: 8 });
  });

  it('adds a level after a Python colon', () => {
    const r = computeEnterEdit('def f():', 8, 'python');
    expect(r).toEqual({ text: 'def f():\n  ', cursor: 11 });
  });
});

describe('autoClose', () => {
  it('closes openers and skips matching closers', () => {
    expect(autoClose('foo', 3, '(')).toEqual({ text: 'foo()', cursor: 4 });
    expect(autoClose('foo()', 4, ')')).toEqual({ skip: true });
    expect(autoClose('', 0, '"')).toEqual({ text: '""', cursor: 1 });
  });

  it('leaves apostrophes inside words alone', () => {
    expect(autoClose("don", 3, "'")).toBeNull();
  });

  it('does not close inside a word', () => {
    expect(autoClose('foobar', 3, '(')).toBeNull();
  });
});

describe('backspacePair / braceOutdent', () => {
  it('deletes empty pairs', () => {
    expect(backspacePair('()', 1)).toEqual({ text: '', cursor: 0 });
    expect(backspacePair('""', 1)).toEqual({ text: '', cursor: 0 });
    expect(backspacePair('(a)', 2)).toBeNull();
  });

  it('dedents a lone closing brace', () => {
    expect(braceOutdent('  ', 2)).toEqual({ text: '}', cursor: 1 });
    expect(braceOutdent('  x', 3)).toBeNull();
  });
});

describe('toggleComment', () => {
  it('comments and uncomments js lines', () => {
    const once = toggleComment('const a = 1;\nconst b = 2;', 0, 24, 'typescript');
    expect(once.text).toBe('// const a = 1;\n// const b = 2;');
    const twice = toggleComment(once.text, 0, once.text.length, 'typescript');
    expect(twice.text).toBe('const a = 1;\nconst b = 2;');
  });

  it('uses hash for python and skips blank lines', () => {
    const r = toggleComment('x = 1\n\ny = 2', 0, 10, 'python');
    expect(r.text).toBe('# x = 1\n\n# y = 2');
  });

  it('wraps html lines', () => {
    const r = toggleComment('<div>', 0, 5, 'html');
    expect(r.text).toBe('<!-- <div> -->');
    const back = toggleComment(r.text, 0, r.text.length, 'html');
    expect(back.text).toBe('<div>');
  });
});

describe('duplicateLines / moveLines / deleteLines', () => {
  const doc = 'a\nb\nc';

  it('duplicates below and follows the copy', () => {
    const r = duplicateLines(doc, 2, 3, 1);
    expect(r.text).toBe('a\nb\nb\nc');
    expect(r.cursor).toBe(4);
  });

  it('moves a block past its neighbour', () => {
    const down = moveLines(doc, 2, 3, 1);
    expect(down.text).toBe('a\nc\nb');
    const up = moveLines('a\nb\nc', 4, 5, -1);
    expect(up.text).toBe('a\nc\nb');
  });

  it('is a no-op at the edges', () => {
    expect(moveLines(doc, 0, 1, -1).text).toBe(doc);
    expect(moveLines(doc, 4, 5, 1).text).toBe(doc);
  });

  it('deletes whole lines', () => {
    expect(deleteLines(doc, 2, 3)).toEqual({ text: 'a\nc', cursor: 2 });
    expect(deleteLines('only', 0, 4)).toEqual({ text: '', cursor: 0 });
  });
});

describe('selectNextOccurrence', () => {
  it('selects the word under a collapsed caret first', () => {
    expect(selectNextOccurrence('foo bar foo', 1, 1)).toEqual({ start: 0, end: 3 });
    expect(selectNextOccurrence('foo bar', 4, 4)).toEqual({ start: 4, end: 7 });
  });

  it('walks forward then wraps', () => {
    expect(selectNextOccurrence('foo x foo', 0, 3)).toEqual({ start: 6, end: 9 });
    expect(selectNextOccurrence('foo x foo', 6, 9)).toEqual({ start: 0, end: 3 });
  });

  it('returns null with no other occurrence', () => {
    expect(selectNextOccurrence('foo bar', 0, 3)).toBeNull();
    expect(selectNextOccurrence('   ', 1, 1)).toBeNull();
  });

  it('exposes wordAt', () => {
    expect(wordAt('foo-bar', 4)).toEqual({ start: 4, end: 7, word: 'bar' });
    // A caret right after a word still belongs to it (like Ctrl+D).
    expect(wordAt('a + b', 1)).toEqual({ start: 0, end: 1, word: 'a' });
    expect(wordAt('a  b', 2)).toBeNull();
  });
});
