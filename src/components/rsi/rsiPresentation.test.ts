import { describe, expect, it } from 'vitest';
import { detectRsiPhase, formatRsiDuration } from './rsiPresentation';

describe('RSI progress presentation', () => {
  it('does not present planning vocabulary as completed progress', () => {
    expect(detectRsiPhase('We will verify, accept or reject, then iterate recursively.')).toBe(0);
  });

  it('follows the latest explicit phase, including a new iteration', () => {
    expect(detectRsiPhase('Phase A: baseline\nPhase E: verify')).toBe(4);
    expect(detectRsiPhase('Phase H: done\nPhase 0: inspect next candidate')).toBe(1);
    expect(detectRsiPhase('Stage 3: execute\n第 4 阶段：验证')).toBe(4);
  });

  it('does not confuse names or words with phase markers', () => {
    expect(detectRsiPhase('phase assessment, phases, steps, stage 12')).toBe(0);
  });

  it('formats elapsed time safely across hour boundaries and clock adjustments', () => {
    expect(formatRsiDuration(3661.7)).toBe('1:01:01');
    expect(formatRsiDuration(-30)).toBe('00:00');
    expect(formatRsiDuration(Number.NaN)).toBe('00:00');
    expect(formatRsiDuration(59)).toBe('00:59');
  });
});
