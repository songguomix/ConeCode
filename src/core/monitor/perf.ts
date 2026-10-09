import type { AppMetricsSnapshot } from '../../types/ipc.types';

/** One monitor tick, normalized for threshold checks. */
export interface PerfSample {
  t: number;
  /** Renderer JS heap (performance.memory), null when unavailable. */
  jsHeapBytes: number | null;
  /** Busiest ConeCode process working set, bytes. */
  mainRSSBytes: number | null;
  freeMemBytes: number;
  /** 1-minute load normalized per CPU. */
  loadPerCpu: number;
}

export interface PerfThresholds {
  maxHeapBytes: number;
  maxMainRSSBytes: number;
  minFreeMemBytes: number;
  maxLoadPerCpu: number;
  /** Consecutive breaching ticks before it counts as an anomaly. */
  confirmations: number;
}

export const DEFAULT_THRESHOLDS: PerfThresholds = {
  maxHeapBytes: 400 * 1024 * 1024,
  maxMainRSSBytes: 800 * 1024 * 1024,
  minFreeMemBytes: 500 * 1024 * 1024,
  maxLoadPerCpu: 4,
  confirmations: 2,
};

export type BreachId = 'heap' | 'mainRSS' | 'freeMem' | 'load';

export function toSample(snap: AppMetricsSnapshot, jsHeapBytes: number | null): PerfSample {
  const rssKB = snap.processes.length > 0
    ? Math.max(...snap.processes.map((p) => p.memory || 0))
    : 0;
  return {
    t: Date.now(),
    jsHeapBytes,
    mainRSSBytes: rssKB > 0 ? rssKB * 1024 : null,
    freeMemBytes: snap.freeMemory,
    loadPerCpu: snap.cpus > 0 ? (snap.load?.[0] ?? 0) / snap.cpus : 0,
  };
}

/** Metric ids currently breaching thresholds (null readings never breach). */
export function checkBreaches(sample: PerfSample, th: PerfThresholds): BreachId[] {
  const out: BreachId[] = [];
  if (sample.jsHeapBytes != null && sample.jsHeapBytes > th.maxHeapBytes) out.push('heap');
  if (sample.mainRSSBytes != null && sample.mainRSSBytes > th.maxMainRSSBytes) out.push('mainRSS');
  if (sample.freeMemBytes < th.minFreeMemBytes) out.push('freeMem');
  if (sample.loadPerCpu > th.maxLoadPerCpu) out.push('load');
  return out;
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return 'n/a';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
  return `${Math.round(bytes / 1024 / 1024)}M`;
}

export function describeBreach(id: BreachId, sample: PerfSample, th: PerfThresholds): string {
  switch (id) {
    case 'heap':
      return `renderer heap ${formatBytes(sample.jsHeapBytes)} > ${formatBytes(th.maxHeapBytes)}`;
    case 'mainRSS':
      return `process RSS ${formatBytes(sample.mainRSSBytes)} > ${formatBytes(th.maxMainRSSBytes)}`;
    case 'freeMem':
      return `free memory ${formatBytes(sample.freeMemBytes)} < ${formatBytes(th.minFreeMemBytes)}`;
    case 'load':
      return `load/cpu ${sample.loadPerCpu.toFixed(1)} > ${th.maxLoadPerCpu}`;
  }
}
