import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT_TOKENS, effectiveContextWindow } from './context';

describe('context budget', () => {
  it('defaults to 256K', () => {
    expect(DEFAULT_CONTEXT_TOKENS).toBe(256_000);
    expect(effectiveContextWindow(undefined, false)).toBe(256_000);
  });

  it('caps big models at 256K unless full context is on', () => {
    expect(effectiveContextWindow(1_000_000, false)).toBe(256_000);
    expect(effectiveContextWindow(1_000_000, true)).toBe(1_000_000);
  });

  it('never inflates small models', () => {
    expect(effectiveContextWindow(32_000, false)).toBe(32_000);
    expect(effectiveContextWindow(32_000, true)).toBe(32_000);
  });
});
