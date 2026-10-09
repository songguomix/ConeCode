import { create } from 'zustand';
import {
  DEFAULT_THRESHOLDS,
  checkBreaches,
  describeBreach,
  toSample,
  type BreachId,
  type PerfSample,
} from '../core/monitor/perf';
import { useSettingsStore } from './settings.store';
import { useLanguageStore } from './language.store';

const ENABLED_KEY = 'conecode.monitorEnabled';
const HISTORY_CAP = 120;
const ANOMALY_CAP = 30;
const ERROR_CAP = 50;
const POLL_MS = 5000;

export interface MonitorAnomaly {
  id: string;
  t: number;
  breaches: BreachId[];
  summary: string;
}

export interface MonitorError {
  t: number;
  message: string;
  source: string;
}

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

interface MonitorStore {
  enabled: boolean;
  samples: PerfSample[];
  streaks: Record<string, number>;
  anomalies: MonitorAnomaly[];
  errors: MonitorError[];
  setEnabled: (on: boolean) => void;
  /** One sampling tick (also the unit-test seam). */
  poll: () => Promise<void>;
  /** Renderer uncaught errors / unhandled rejections land here. */
  captureError: (message: string, source: string) => void;
  clearErrors: () => void;
  clearAnomalies: () => void;
  start: () => void;
  stop: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;

function notifyAnomaly(summary: string): void {
  try {
    const t = useLanguageStore.getState().t;
    const mode = useSettingsStore.getState().notificationMode ?? 'background';
    void (window as any).electronAPI?.notification?.show?.({
      title: t('monitorAnomalyTitle'),
      body: summary.slice(0, 200),
      mode,
    });
  } catch {}
}

export const useMonitorStore = create<MonitorStore>((set, get) => ({
  enabled: loadEnabled(),
  samples: [],
  streaks: {},
  anomalies: [],
  errors: [],

  setEnabled: (on) => {
    try {
      localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
    } catch {}
    set({ enabled: on });
    if (on) get().start();
    else get().stop();
  },

  poll: async () => {
    if (!get().enabled) return;
    let snap: any = null;
    try {
      snap = await (window as any).electronAPI?.app?.getAppMetrics?.();
    } catch {}
    if (!snap) return;
    let heap: number | null = null;
    try {
      const mem = (performance as any)?.memory;
      if (mem && typeof mem.usedJSHeapSize === 'number') heap = mem.usedJSHeapSize;
    } catch {}
    const sample = toSample(snap, heap);
    const breaches = checkBreaches(sample, DEFAULT_THRESHOLDS);
    const streaks = { ...get().streaks };
    for (const id of ['heap', 'mainRSS', 'freeMem', 'load'] as BreachId[]) {
      streaks[id] = breaches.includes(id) ? (streaks[id] || 0) + 1 : 0;
    }
    const confirmed = (Object.keys(streaks) as BreachId[]).filter(
      (id) => streaks[id] === DEFAULT_THRESHOLDS.confirmations,
    );
    const samples = [...get().samples, sample].slice(-HISTORY_CAP);
    set({ samples, streaks });
    if (confirmed.length === 0) return;

    const summary = confirmed.map((id) => describeBreach(id, sample, DEFAULT_THRESHOLDS)).join('; ');
    const anomaly: MonitorAnomaly = {
      id: `a${Date.now()}`,
      t: Date.now(),
      breaches: confirmed,
      summary,
    };
    set((s) => ({ anomalies: [anomaly, ...s.anomalies].slice(0, ANOMALY_CAP) }));
    // Check-only monitor: record + notify. Diagnosis and any fix always go
    // through the perf-monitor skill on demand (any mode), never auto-run.
    notifyAnomaly(summary);
  },

  captureError: (message, source) => {
    const msg = String(message || '').slice(0, 300);
    if (!msg) return;
    const errs = get().errors;
    const last = errs[errs.length - 1];
    // Same crash spamming every frame tells us nothing new.
    if (last && last.message === msg && Date.now() - last.t < 5000) return;
    set({ errors: [...errs, { t: Date.now(), message: msg, source }].slice(-ERROR_CAP) });
  },

  clearErrors: () => set({ errors: [] }),
  clearAnomalies: () => set({ anomalies: [] }),

  start: () => {
    if (timer) return;
    timer = setInterval(() => {
      void get().poll();
    }, POLL_MS);
    void get().poll();
  },

  stop: () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  },
}));
