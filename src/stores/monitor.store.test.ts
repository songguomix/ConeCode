import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAnomaly, useMonitorStore } from './monitor.store';
import { useLanguageStore } from './language.store';

const MB = 1024 * 1024;

const show = vi.fn(async () => true);
const getAppMetrics = vi.fn(async () => ({
  processes: [{ pid: 1, type: 'Browser', cpu: 5, memory: 100 * 1024 }],
  mainMemory: { rss: 0, heapUsed: 0, heapTotal: 0 },
  load: [2, 2, 2],
  freeMemory: 8 * 1024 * MB,
  totalMemory: 16 * 1024 * MB,
  cpus: 8,
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  (globalThis as any).window = {
    electronAPI: {
      notification: { show },
      app: { getAppMetrics },
      conversation: { create: vi.fn(), list: vi.fn(async () => []), update: vi.fn() },
      message: { create: vi.fn(), list: vi.fn(async () => []) },
      chat: { onChunk: vi.fn(() => () => {}), stream: vi.fn(), stop: vi.fn() },
    },
  };
  useMonitorStore.setState({
    enabled: true,
    samples: [],
    streaks: {},
    anomalies: [],
    errors: [],
  });
  useMonitorStore.getState().stop();
});

describe('monitor sampling', () => {
  it('stays quiet on calm ticks, confirms after two breaches', async () => {
    await useMonitorStore.getState().poll();
    expect(useMonitorStore.getState().anomalies).toHaveLength(0);
    getAppMetrics.mockResolvedValueOnce({
      processes: [{ pid: 1, type: 'Browser', cpu: 90, memory: 100 * 1024 }],
      mainMemory: { rss: 0, heapUsed: 0, heapTotal: 0 },
      load: [80, 80, 80],
      freeMemory: 8 * 1024 * MB,
      totalMemory: 16 * 1024 * MB,
      cpus: 8,
    });
    await useMonitorStore.getState().poll();
    expect(useMonitorStore.getState().anomalies).toHaveLength(0);
    getAppMetrics.mockResolvedValueOnce({
      processes: [{ pid: 1, type: 'Browser', cpu: 90, memory: 100 * 1024 }],
      mainMemory: { rss: 0, heapUsed: 0, heapTotal: 0 },
      load: [80, 80, 80],
      freeMemory: 8 * 1024 * MB,
      totalMemory: 16 * 1024 * MB,
      cpus: 8,
    });
    await useMonitorStore.getState().poll();
    const anomalies = useMonitorStore.getState().anomalies;
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].breaches).toEqual(['load']);
    expect(show).toHaveBeenCalled();
  });

  it('never dispatches anything by itself — check only, fix via skill', async () => {
    // Even a confirmed anomaly must not start runs or touch other stores:
    // diagnosis goes through the perf-monitor skill on demand, in any mode.
    const breach = {
      processes: [{ pid: 1, type: 'Browser', cpu: 90, memory: 100 * 1024 }],
      mainMemory: { rss: 0, heapUsed: 0, heapTotal: 0 },
      load: [80, 80, 80],
      freeMemory: 8 * 1024 * MB,
      totalMemory: 16 * 1024 * MB,
      cpus: 8,
    };
    getAppMetrics.mockResolvedValueOnce(breach);
    await useMonitorStore.getState().poll();
    getAppMetrics.mockResolvedValueOnce(breach);
    await useMonitorStore.getState().poll();
    expect(useMonitorStore.getState().anomalies).toHaveLength(1);
    expect(useMonitorStore.getState().anomalies[0]).not.toHaveProperty('dispatched');
  });

  it('captures renderer errors with spam dedupe', () => {
    const cap = useMonitorStore.getState().captureError;
    cap('boom', 'window.onerror');
    cap('boom', 'window.onerror');
    expect(useMonitorStore.getState().errors).toHaveLength(1);
    cap('different', 'unhandledrejection');
    expect(useMonitorStore.getState().errors).toHaveLength(2);
  });

  it('renders anomalies in the active locale with raw numbers', () => {
    const a = {
      breaches: ['heap', 'load'] as const,
      sample: { jsHeapBytes: 500 * MB, mainRSSBytes: null, freeMemBytes: 8 * 1024 * MB, loadPerCpu: 5.5 },
      summary: 'renderer heap 500M > 400M; load/cpu 5.5 > 4',
    };
    useLanguageStore.setState({ locale: 'en' });
    let t = useLanguageStore.getState().t;
    expect(formatAnomaly(a as any, t)).toBe('JS heap 500M > 400M; Load / CPU 5.5 > 4');
    useLanguageStore.setState({ locale: 'zh' });
    t = useLanguageStore.getState().t;
    expect(formatAnomaly(a as any, t)).toBe('JS 堆 500M > 400M; 负载 / CPU 5.5 > 4');
    useLanguageStore.setState({ locale: 'ja' });
    t = useLanguageStore.getState().t;
    expect(formatAnomaly(a as any, t)).toContain('JSヒープ');
    useLanguageStore.setState({ locale: 'zh' });
  });
});
