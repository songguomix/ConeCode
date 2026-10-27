import { describe, expect, it } from 'vitest';
import { CONTEXT_PRESETS, formatLimitTokens, parseLimitInput } from './limitInput';

describe('parseLimitInput', () => {
  it('accepts plain token counts', () => {
    expect(parseLimitInput('200000')).toBe(200000);
    expect(parseLimitInput(' 131072 ')).toBe(131072);
  });

  it('accepts human suffixes: k, 万/w, m — case and spacing tolerant', () => {
    expect(parseLimitInput('128k')).toBe(128000);
    expect(parseLimitInput('128K')).toBe(128000);
    expect(parseLimitInput('128 k')).toBe(128000);
    expect(parseLimitInput('20万')).toBe(200000);
    expect(parseLimitInput('20w')).toBe(200000);
    expect(parseLimitInput('1m')).toBe(1000000);
    expect(parseLimitInput('1M')).toBe(1000000);
    expect(parseLimitInput('0.5m')).toBe(500000);
    expect(parseLimitInput('1.5k')).toBe(1500);
  });

  it('rejects garbage, empties, and non-positive values', () => {
    expect(parseLimitInput('')).toBeNull();
    expect(parseLimitInput('   ')).toBeNull();
    expect(parseLimitInput('abc')).toBeNull();
    expect(parseLimitInput('128x')).toBeNull();
    expect(parseLimitInput('-5')).toBeNull();
    expect(parseLimitInput('0')).toBeNull();
    expect(parseLimitInput('1e9')).toBeNull();
  });
});

describe('formatLimitTokens', () => {
  it('renders short human-readable sizes', () => {
    expect(formatLimitTokens(128000)).toBe('128K');
    expect(formatLimitTokens(60000)).toBe('60K');
    expect(formatLimitTokens(1000000)).toBe('1M');
    expect(formatLimitTokens(1500000)).toBe('1.5M');
    expect(formatLimitTokens(4096)).toBe('4.1K');
    expect(formatLimitTokens(999)).toBe('999');
  });
});

describe('CONTEXT_PRESETS', () => {
  it('labels round-trip through the parser', () => {
    for (const preset of CONTEXT_PRESETS) {
      expect(parseLimitInput(preset.label.toLowerCase())).toBe(preset.value);
    }
  });
});
