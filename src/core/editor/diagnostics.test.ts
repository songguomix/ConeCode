import { describe, expect, it } from 'vitest';
import {
  diagnose, scanBrackets, matchBracket, applyQuickFixes, offsetToLineCol,
} from './diagnostics';

describe('scanBrackets', () => {
  it('accepts balanced code', () => {
    expect(scanBrackets('function f() { return [1, (2)]; }', 'typescript').errors).toEqual([]);
  });

  it('reports mismatches and unexpected closers', () => {
    const { errors } = scanBrackets('function f(] }', 'typescript');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/Mismatched/);
    expect(scanBrackets(')', 'typescript').errors[0].message).toMatch(/Unexpected/);
  });

  it('flags unclosed brackets at the opener', () => {
    const { errors, unclosed } = scanBrackets('if (x) {', 'typescript');
    expect(unclosed.map((u) => u.ch)).toEqual(['{']);
    expect(errors[0]).toMatchObject({ line: 1, col: 8, severity: 'error' });
  });

  it('ignores brackets in strings and comments', () => {
    expect(scanBrackets('const s = "({["; // }\ncall();', 'typescript').errors).toEqual([]);
    expect(scanBrackets('x = 1  # (oops\nprint(x)', 'python').errors).toEqual([]);
    expect(scanBrackets('/* { */ ()', 'css').errors).toEqual([]);
  });
});

describe('matchBracket', () => {
  it('jumps both directions', () => {
    const doc = '(a[b]c)';
    expect(matchBracket(doc, 'typescript', 0)).toBe(6);
    expect(matchBracket(doc, 'typescript', 6)).toBe(0);
    expect(matchBracket(doc, 'typescript', 2)).toBe(4);
  });

  it('skips strings and returns null without a match', () => {
    expect(matchBracket('("(")', 'typescript', 0)).toBe(4);
    expect(matchBracket('(a', 'typescript', 0)).toBeNull();
    expect(matchBracket('abc', 'typescript', 1)).toBeNull();
  });
});

describe('diagnose', () => {
  it('maps JSON errors to line/col', () => {
    const [err] = diagnose('{\n  "a": 1,\n}', 'json');
    expect(err.severity).toBe('error');
    expect(err.line).toBe(3);
  });

  it('accepts valid JSON silently', () => {
    expect(diagnose('{"a": [1, 2]}', 'json')).toEqual([]);
  });

  it('warns on trailing whitespace', () => {
    const out = diagnose('clean();  \nmore();', 'typescript');
    expect(out).toEqual([
      { line: 1, col: 9, endCol: 11, severity: 'warning', message: 'Trailing whitespace' },
    ]);
  });

  it('orders errors before warnings', () => {
    const out = diagnose('if (x) {  \n', 'typescript');
    expect(out[0].severity).toBe('error');
    expect(out[out.length - 1].severity).toBe('warning');
  });

  it('skips huge files', () => {
    expect(diagnose('x'.repeat(600_000), 'typescript')).toEqual([]);
  });
});

describe('applyQuickFixes', () => {
  it('trims whitespace and closes brackets', () => {
    const r = applyQuickFixes('function f() {  \n  return 1;  ', 'typescript');
    expect(r.text).toBe('function f() {\n  return 1;\n}');
    expect(r.applied).toEqual(['2 whitespace', '1 bracket']);
  });

  it('reports nothing when clean', () => {
    expect(applyQuickFixes('const a = 1;', 'typescript')).toEqual({ text: 'const a = 1;', applied: [] });
  });
});

describe('offsetToLineCol', () => {
  it('counts lines and expands tabs', () => {
    expect(offsetToLineCol('ab\n\tc', 4)).toEqual({ line: 2, col: 3 });
    expect(offsetToLineCol('ab', 0)).toEqual({ line: 1, col: 1 });
  });
});
