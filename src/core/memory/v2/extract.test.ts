import { describe, expect, it } from 'vitest';
import { buildExtractionRequest } from './extract';

describe('memory extraction cache prefix', () => {
  it('preserves the prefix when a task, signal or the storage order changes', () => {
    const first = buildExtractionRequest({
      projectName: 'project',
      known: ['Use pnpm', 'Prefer TypeScript'],
      taskText: 'Fix the broken build',
      signals: [{ kind: 'task_failed', weight: 1, evidence: 'build failed' }],
      messages: [{ role: 'user', content: 'The build is broken' }],
    });
    const next = buildExtractionRequest({
      projectName: 'project',
      known: ['Prefer TypeScript', 'Use pnpm'],
      taskText: 'Update test coverage',
      signals: [{ kind: 'problem_solved', weight: 1, evidence: 'test fixed' }],
      messages: [{ role: 'assistant', content: 'Tests passed' }],
    });
    expect([next.system, next.reference]).toEqual([first.system, first.reference]);
    expect(next.reference).toContain('Use pnpm');
    expect(next.reference).not.toContain('Update test coverage');
    expect(next.user).toContain('problem_solved');
    expect(next.user).toContain('Update test coverage');
    expect(next.user).toContain('Tests passed');
  });
});
