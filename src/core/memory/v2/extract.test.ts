import { describe, expect, it } from 'vitest';
import { buildExtractionRequest, parseExtractionV2 } from './extract';

describe('long-term memory eligibility', () => {
  it('drops working items and snapshots even when the provider marks them confirmed and global', () => {
    const inputs = [
      ['progress', 'The installer is ready for review.'],
      ['todo', 'Review the installer before release.'],
      ['user_fact', '当前分支为 release/november。'],
      ['technical_decision', '本次任务使用 npm 安装依赖。'],
      ['success_experience', 'All 47 tests passed after the build.'],
      ['project_fact', 'The dev server is listening on port 5174.'],
      ['project_fact', '当前进度为 70%。'],
    ];
    const memories = inputs.map(([type, content]) => ({ type, content, scope: 'global', status: 'confirmed' }));
    expect(parseExtractionV2(JSON.stringify({ memories }))).toEqual([]);
  });

  it('retains standing rules and version requirements without volatile metadata', () => {
    const rules = [
      '合并前必须检查当前分支并运行测试。',
      'If the current branch is main, require a reviewed pull request.',
      'Node.js 20 is required because the native extension uses its ABI.',
    ];
    const snapshot = 'Current version of Node.js: 20.11.0';
    const memories = rules.map((content) => ({ content, title: snapshot, why: snapshot, tags: ['policy', snapshot] }));
    const records = parseExtractionV2(JSON.stringify({ memories }));
    expect(records.map((r) => r.content)).toEqual(rules);
    for (const record of records) {
      expect(record.title).toBe(record.content.slice(0, 60));
      expect(record.why).toBeUndefined();
      expect(record.tags).toEqual(['policy']);
    }
  });
});

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
