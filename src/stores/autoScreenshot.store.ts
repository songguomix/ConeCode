import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

export type AutoScreenshotTarget = 'auto' | 'window' | 'preview' | 'screen';

export interface AutoScreenshotConfig {
  defaultTarget: AutoScreenshotTarget;
  autoSaveToDisk: boolean;
  captureDelayMs: number;
  maxHistory: number;
}

export interface AutoScreenshotItem {
  id: string;
  timestamp: number;
  target: 'window' | 'preview' | 'screen';
  label: string;
  width: number;
  height: number;
  dataUrl: string;
  savedPath?: string;
}

export interface CaptureNowResult {
  ok: boolean;
  item?: AutoScreenshotItem;
  error?: string;
  needsPermission?: string;
}

const STORAGE_KEY = 'conecode-auto-screenshot-config';

const DEFAULT_CONFIG: AutoScreenshotConfig = {
  defaultTarget: 'auto',
  autoSaveToDisk: false,
  captureDelayMs: 150,
  maxHistory: 24,
};

function loadConfig(): AutoScreenshotConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw);
    return {
      defaultTarget: ['auto', 'window', 'preview', 'screen'].includes(parsed?.defaultTarget)
        ? parsed.defaultTarget
        : DEFAULT_CONFIG.defaultTarget,
      autoSaveToDisk: typeof parsed?.autoSaveToDisk === 'boolean' ? parsed.autoSaveToDisk : DEFAULT_CONFIG.autoSaveToDisk,
      captureDelayMs: Number.isFinite(parsed?.captureDelayMs)
        ? Math.max(0, Math.min(3000, Number(parsed.captureDelayMs)))
        : DEFAULT_CONFIG.captureDelayMs,
      maxHistory: Number.isFinite(parsed?.maxHistory)
        ? Math.max(4, Math.min(60, Number(parsed.maxHistory)))
        : DEFAULT_CONFIG.maxHistory,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config: AutoScreenshotConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {}
}

interface AutoScreenshotState {
  config: AutoScreenshotConfig;
  history: AutoScreenshotItem[];
  capturing: boolean;
  lastError: string | null;
  setConfig: (patch: Partial<AutoScreenshotConfig>) => void;
  recordCapture: (item: AutoScreenshotItem) => void;
  removeHistoryItem: (id: string) => void;
  clearHistory: () => void;
  captureNow: (opts?: {
    target?: AutoScreenshotTarget;
    delayMs?: number;
    saveToDisk?: boolean;
    label?: string;
  }) => Promise<CaptureNowResult>;
}

export const useAutoScreenshotStore = create<AutoScreenshotState>((set, get) => ({
  config: loadConfig(),
  history: [],
  capturing: false,
  lastError: null,

  setConfig: (patch) => {
    const next = { ...get().config, ...patch };
    saveConfig(next);
    set({ config: next });
  },

  recordCapture: (item) => {
    const max = get().config.maxHistory;
    set((s) => ({
      history: [item, ...s.history].slice(0, max),
      lastError: null,
    }));
  },

  removeHistoryItem: (id) => {
    set((s) => ({ history: s.history.filter((x) => x.id !== id) }));
  },

  clearHistory: () => set({ history: [] }),

  captureNow: async (opts = {}) => {
    const cfg = get().config;
    const target = opts.target ?? cfg.defaultTarget;
    const delayMs = opts.delayMs ?? cfg.captureDelayMs;
    const saveToDisk = opts.saveToDisk ?? cfg.autoSaveToDisk;
    const label = opts.label?.trim() || target;

    const api = window.electronAPI?.autoScreenshot;
    if (!api?.capture) {
      const error = 'Auto-screenshot IPC bridge is unavailable in this environment.';
      set({ lastError: error });
      return { ok: false, error };
    }

    set({ capturing: true, lastError: null });
    try {
      const res = await api.capture({ target, delayMs, saveToDisk, label });
      if (!res?.ok) {
        const error = res?.error || 'Screenshot capture failed';
        set({ capturing: false, lastError: error });
        return { ok: false, error, needsPermission: res?.needsPermission };
      }
      if (!Number.isInteger(res.width) || res.width < 1 || !Number.isInteger(res.height) || res.height < 1
        || typeof res.dataUrl !== 'string' || !res.dataUrl.startsWith('data:image/png;base64,')
        || !['window', 'preview', 'screen'].includes(res.target)) {
        throw new Error('Screenshot capture returned incomplete image data.');
      }
      // Decode the same bytes that will be attached to the model's next turn.
      // IPC success and positive metadata alone can accompany an empty frame.
      const image = new Image();
      image.src = res.dataUrl;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) {
        throw new Error('Screenshot capture returned an empty image.');
      }
      const item: AutoScreenshotItem = {
        id: uuidv4(),
        timestamp: res.timestamp || Date.now(),
        target: res.target,
        label,
        width: res.width,
        height: res.height,
        dataUrl: res.dataUrl,
        ...(res.savedPath ? { savedPath: res.savedPath } : {}),
      };
      get().recordCapture(item);
      set({ capturing: false });
      return { ok: true, item };
    } catch (e: any) {
      const error = e?.message || String(e);
      set({ capturing: false, lastError: error });
      return { ok: false, error };
    }
  },
}));
