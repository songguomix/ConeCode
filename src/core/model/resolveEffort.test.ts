import { describe, expect, it } from 'vitest';
import { clampEffort, resolveEffort } from './resolveEffort';

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

describe('clampEffort (model-declared levels)', () => {
  it('passes values through when the model declares no concrete levels', () => {
    expect(clampEffort('high')).toBe('high');
    expect(clampEffort('medium', [])).toBe('medium');
    expect(clampEffort('medium', ['auto'])).toBe('medium');
  });

  it('keeps a level the model declares', () => {
    expect(clampEffort('high', ['low', 'medium', 'high'])).toBe('high');
    expect(clampEffort('medium', ['auto', 'low', 'medium'])).toBe('medium');
  });

  it('snaps to the nearest declared level, cheaper on ties', () => {
    expect(clampEffort('medium', ['low', 'high'])).toBe('low');
    expect(clampEffort('high', ['low', 'medium'])).toBe('medium');
    expect(clampEffort('low', ['high'])).toBe('high');
  });

  it('resolveEffort clamps auto and explicit picks to the model levels', () => {
    // Auto would resolve to high for a refactor ask, but this model stops at medium.
    expect(resolveEffort('auto', '请重构认证模块并补测试', ['low', 'medium'])).toBe('medium');
    expect(resolveEffort('high', 'ok', ['low'])).toBe('low');
    expect(resolveEffort('low', '随便聊聊', ['low', 'medium', 'high'])).toBe('low');
  });
});
