import { describe, expect, it } from 'vitest';
import { summarizeTodos } from './todoPresentation';

describe('summarizeTodos', () => {
  it('prefers the active item and calculates progress', () => {
    const summary = summarizeTodos([
      { content: 'done', status: 'completed' },
      { content: 'next', status: 'pending' },
      { content: 'working', status: 'in_progress' },
    ]);

    expect(summary).toMatchObject({ done: 1, total: 3, percent: 33, allDone: false });
    expect(summary.current?.content).toBe('working');
  });

  it('falls back to pending and recognizes completion', () => {
    expect(summarizeTodos([
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'pending' },
    ]).current?.content).toBe('second');

    expect(summarizeTodos([
      { content: 'only', status: 'completed' },
    ])).toMatchObject({ done: 1, total: 1, percent: 100, allDone: true });
  });
});
