import { describe, expect, it } from 'vitest';
import { buildDisplayDiff, countDisplayDiff } from './displayDiff';

describe('display diff', () => {
  it('shows a new file without a phantom deletion or trailing blank line', () => {
    expect(buildDisplayDiff('', 'import first;\n\n')).toEqual({
      approximate: false,
      lines: [
        { type: 'added', content: 'import first;', newLine: 1 },
        { type: 'added', content: '', newLine: 2 },
      ],
    });
    expect(countDisplayDiff('', 'import first;\n\n')).toEqual({ added: 2, removed: 0, approximate: false });
  });

  it('realigns context after an insertion and preserves both line numbers', () => {
    const before = 'first\nsecond\nthird\nfourth\n';
    const after = 'first\ninserted\nsecond\nfourth\n';
    expect(buildDisplayDiff(before, after).lines).toEqual([
      { type: 'unchanged', content: 'first', oldLine: 1, newLine: 1 },
      { type: 'added', content: 'inserted', newLine: 2 },
      { type: 'unchanged', content: 'second', oldLine: 2, newLine: 3 },
      { type: 'removed', content: 'third', oldLine: 3 },
      { type: 'unchanged', content: 'fourth', oldLine: 4, newLine: 4 },
    ]);
    expect(countDisplayDiff(before, after)).toEqual({ added: 1, removed: 1, approximate: false });
  });

  it('marks oversized comparisons as approximate and still includes both versions', () => {
    const before = 'first\n' + 'old\n'.repeat(2001) + 'last\n';
    const after = 'first\n' + 'new\n'.repeat(2001) + 'last\n';
    const preview = buildDisplayDiff(before, after);
    expect(preview.approximate).toBe(true);
    expect(preview.lines).toHaveLength(4004);
    expect(preview.lines[0]?.type).toBe('unchanged');
    expect(preview.lines[preview.lines.length - 1]?.type).toBe('unchanged');
    expect(countDisplayDiff(before, after)).toEqual({ added: 2001, removed: 2001, approximate: true });
  });
});
