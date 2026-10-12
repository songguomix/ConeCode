import { describe, expect, it } from 'vitest';
import { rsiCanStart } from './rsiStart';

describe('rsi start gate', () => {
  it('blocks without a model everywhere', () => {
    expect(rsiCanStart({ isMac: false, screenRecording: false, accessibility: false, hasModel: false })).toBe(false);
    expect(rsiCanStart({ isMac: true, screenRecording: true, accessibility: true, hasModel: false })).toBe(false);
  });

  it('makes screen recording mandatory on mac', () => {
    expect(rsiCanStart({ isMac: true, screenRecording: false, accessibility: true, hasModel: true })).toBe(false);
    expect(rsiCanStart({ isMac: true, screenRecording: true, accessibility: false, hasModel: true })).toBe(false);
    expect(rsiCanStart({ isMac: true, screenRecording: true, accessibility: true, hasModel: true })).toBe(true);
  });

  it('does not gate permissions off mac', () => {
    expect(rsiCanStart({ isMac: false, screenRecording: false, accessibility: false, hasModel: true })).toBe(true);
  });
});
