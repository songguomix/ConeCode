import { describe, expect, it } from 'vitest';
import { resolveEffort } from './resolveEffort';

describe('resolveEffort (auto thinking intensity)', () => {
  it('passes through explicit levels', () => {
    expect(resolveEffort('low', '重构整个架构')).toBe('low');
    expect(resolveEffort('high', 'hi')).toBe('high');
  });

  it('auto stays low for short simple asks', () => {
    expect(resolveEffort('auto', 'ok')).toBe('low');
  });

  it('auto climbs for design/refactor language', () => {
    expect(resolveEffort('auto', '请重构认证模块并补测试')).toBe('high');
    expect(resolveEffort('auto', 'analyze why the cache misses')).toBe('high');
  });

  it('auto climbs for long or multi-clause prompts', () => {
    expect(resolveEffort('auto', 'x'.repeat(500))).toBe('high');
    expect(resolveEffort('auto', 'a, b, c, d, e. f; g')).toBe('high');
  });

  it('auto is medium for ordinary work', () => {
    expect(resolveEffort('auto', 'Fix the login button styling on the home page')).toBe('medium');
  });
});
