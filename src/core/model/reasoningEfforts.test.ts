import { describe, expect, it } from 'vitest';
import { detectReasoningEfforts, normalizeEffort } from './reasoningEfforts';

describe('normalizeEffort', () => {
  it('maps provider spellings onto our four levels', () => {
    expect(normalizeEffort('minimal')).toBe('low');
    expect(normalizeEffort(' L ')).toBe('low');
    expect(normalizeEffort('MEDIUM')).toBe('medium');
    expect(normalizeEffort('balanced')).toBe('medium');
    expect(normalizeEffort('xhigh')).toBe('high');
    expect(normalizeEffort('extra_high')).toBe('high');
    expect(normalizeEffort('auto')).toBe('auto');
  });

  it('rejects anything it cannot map', () => {
    expect(normalizeEffort('none')).toBeNull();
    expect(normalizeEffort(3)).toBeNull();
    expect(normalizeEffort(null)).toBeNull();
    expect(normalizeEffort({ value: 'low' })).toBeNull();
  });
});

describe('detectReasoningEfforts', () => {
  it('is undefined when metadata says nothing (UI shows the full ladder)', () => {
    expect(detectReasoningEfforts()).toBeUndefined();
    expect(detectReasoningEfforts({})).toBeUndefined();
    expect(detectReasoningEfforts({ supported_parameters: ['reasoning', 'max_tokens'] })).toBeUndefined();
  });

  it('reads effort lists from the shapes providers use', () => {
    expect(detectReasoningEfforts({ reasoning_efforts: ['low', 'medium', 'high'] })).toEqual(['low', 'medium', 'high']);
    expect(detectReasoningEfforts({ reasoning: { efforts: ['minimal', 'high'] } })).toEqual(['low', 'high']);
    expect(detectReasoningEfforts({ reasoning_effort: { enum: ['low', 'high'] } })).toEqual(['low', 'high']);
  });

  it('parses supported_parameters entries that carry levels', () => {
    expect(detectReasoningEfforts({
      supported_parameters: ['reasoning_effort:low', 'thinking.effort:medium', 'max_tokens'],
    })).toEqual(['low', 'medium']);
  });

  it('returns levels in canonical order, deduped', () => {
    expect(detectReasoningEfforts({ reasoning_efforts: ['high', 'minimal', 'low', 'l'] })).toEqual(['low', 'high']);
  });
});
