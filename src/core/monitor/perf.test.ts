import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  checkBreaches,
  describeBreach,
  formatBytes,
  toSample,
  type PerfSample,
} from './perf';

const MB = 1024 * 1024;

function snap(over: Record<string, any> = {}) {
  return {
    processes: [{ pid: 1, type: 'Browser', cpu: 5, memory: 100 * 1024 }],
    mainMemory: { rss: 0, heapUsed: 0, heapTotal: 0 },
    load: [2, 2, 2],
    freeMemory: 8 * 1024 * MB,
    totalMemory: 16 * 1024 * MB,
    cpus: 8,
    ...over,
  };
}

const calm: PerfSample = {
  t: 0,
  jsHeapBytes: 100 * MB,
  mainRSSBytes: 100 * MB,
  freeMemBytes: 8 * 1024 * MB,
  loadPerCpu: 0.25,
};

describe('perf thresholds', () => {
  it('stays quiet on a calm sample', () => {
    expect(checkBreaches(calm, DEFAULT_THRESHOLDS)).toEqual([]);
  });

  it('flags each breach kind, never on null readings', () => {
    expect(checkBreaches({ ...calm, jsHeapBytes: 500 * MB }, DEFAULT_THRESHOLDS)).toEqual(['heap']);
    expect(checkBreaches({ ...calm, mainRSSBytes: 900 * MB }, DEFAULT_THRESHOLDS)).toEqual(['mainRSS']);
    expect(checkBreaches({ ...calm, freeMemBytes: 100 * MB }, DEFAULT_THRESHOLDS)).toEqual(['freeMem']);
    expect(checkBreaches({ ...calm, loadPerCpu: 9 }, DEFAULT_THRESHOLDS)).toEqual(['load']);
    expect(
      checkBreaches({ ...calm, jsHeapBytes: null, mainRSSBytes: null }, DEFAULT_THRESHOLDS),
    ).toEqual([]);
  });

  it('normalizes snapshots (busiest RSS, load per cpu)', () => {
    const s = toSample(
      snap({ processes: [{ pid: 1, type: 'A', cpu: 1, memory: 50 * 1024 }, { pid: 2, type: 'B', cpu: 1, memory: 300 * 1024 }], load: [16, 0, 0] }),
      10 * MB,
    );
    expect(s.mainRSSBytes).toBe(300 * 1024 * 1024);
    expect(s.loadPerCpu).toBe(2);
  });

  it('describes breaches with numbers', () => {
    const d = describeBreach('heap', { ...calm, jsHeapBytes: 500 * MB }, DEFAULT_THRESHOLDS);
    expect(d).toContain('500M');
    expect(formatBytes(null)).toBe('n/a');
  });
});
