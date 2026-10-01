import { describe, it, expect } from 'vitest';
import { addedLineNumbers } from './diff';

describe('addedLineNumbers', () => {
  it('returns empty for identical content', () => {
    expect(addedLineNumbers('a\nb\nc', 'a\nb\nc')).toEqual([]);
  });

  it('marks appended lines', () => {
    expect(addedLineNumbers('a\nb', 'a\nb\nc\nd')).toEqual([3, 4]);
  });

  it('marks a fully new file', () => {
    expect(addedLineNumbers('', 'x\ny')).toEqual([1, 2]);
  });

  it('marks an edited line', () => {
    expect(addedLineNumbers('a\nb\nc', 'a\nB\nc')).toEqual([2]);
  });

  it('marks insertions in the middle', () => {
    expect(addedLineNumbers('a\nd', 'a\nb\nc\nd')).toEqual([2, 3]);
  });

  it('marks deletions as nothing added', () => {
    expect(addedLineNumbers('a\nb\nc', 'a\nc')).toEqual([]);
  });

  it('handles multi-hunk edits', () => {
    const before = 'l1\nl2\nl3\nl4\nl5\nl6';
    const after = 'l1\nL2\nl3\nl4\nL5\nl6';
    expect(addedLineNumbers(before, after)).toEqual([2, 5]);
  });
});
