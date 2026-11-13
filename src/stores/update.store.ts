import { create } from 'zustand';
import type { ElectronAPI } from '../types/ipc.types';
import type {
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateErrorCode,
} from '../core/updates/updateClient';

const DISMISSED_KEY = 'conecode.update.dismissedVersion';
const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export type UpdateDownloadError = 'blocked' | 'busy' | 'failed' | 'unsupported';

function readDismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissedVersion(version: string | null): void {
  try {
    if (version) localStorage.setItem(DISMISSED_KEY, version);
    else localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Private mode / disabled storage: dismissal just won't survive a restart.
  }
}

interface UpdateStore {
  /** `initialize` ran (check started + progress bridge attached). */
  initialized: boolean;
  checking: boolean;
  appVersion: string | null;
  result: UpdateCheckResult | null;
  errorCode: UpdateErrorCode | null;
  detail: string | null;
  lastCheckedAt: number | null;
  /** Popup visibility. Closing it moves the offer into Settings. */
  dialogOpen: boolean;
  dismissedVersion: string | null;
  download: UpdateDownloadProgress | null;
  downloadStarting: boolean;
  downloadError: UpdateDownloadError | null;

  initialize: () => Promise<void>;
  check: (options?: { auto?: boolean }) => Promise<void>;
  dismissDialog: () => void;
  startDownload: () => Promise<void>;
  reveal: () => Promise<void>;
}

let progressApi: ElectronAPI['update'] | null = null;
let unsubscribeProgress: (() => void) | null = null;
let downloadWatchdog: ReturnType<typeof setTimeout> | null = null;

const DOWNLOAD_START_TIMEOUT_MS = 25_000;

function clearDownloadWatchdog(): void {
  if (downloadWatchdog) {
    clearTimeout(downloadWatchdog);
    downloadWatchdog = null;
  }
}

type SetState = (partial: Partial<UpdateStore>) => void;

/** Attach the main-process progress channel once per bridge instance. */
function attachProgressBridge(set: SetState): void {
  const api = window.electronAPI?.update;
  if (!api?.onProgress) return;
  if (progressApi === api && unsubscribeProgress) return;
  try {
    unsubscribeProgress?.();
  } catch {
    // Old bridge is gone (reload); nothing to release.
  }
  progressApi = api;
  unsubscribeProgress = api.onProgress((progress) => {
    clearDownloadWatchdog();
    set({
      download: progress,
      downloadStarting: false,
      downloadError: progress.state === 'error' ? 'failed' : null,
    });
  });
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  initialized: false,
  checking: false,
  appVersion: null,
  result: null,
  errorCode: null,
  detail: null,
  lastCheckedAt: null,
  dialogOpen: false,
  dismissedVersion: readDismissedVersion(),
  download: null,
  downloadStarting: false,
  downloadError: null,

  initialize: async () => {
    if (get().initialized) return;
    set({ initialized: true });
    attachProgressBridge(set);

    try {
      const version = await window.electronAPI?.app?.getVersion?.();
      if (version) set({ appVersion: version.replace(/^v/i, '') });
    } catch {
      // Version is cosmetic here; the check result carries its own copy.
    }

    await get().check({ auto: true });
  },

  check: async (options) => {
    const auto = options?.auto === true;
    const { checking, lastCheckedAt } = get();
    if (checking) return;
    if (auto && lastCheckedAt && Date.now() - lastCheckedAt < AUTO_CHECK_INTERVAL_MS) return;

    const bridge = window.electronAPI?.update;
    if (!bridge?.check) {
      set({ errorCode: 'unavailable', detail: 'Update checks need the desktop app' });
      return;
    }

    set({ checking: true, errorCode: null, detail: null });
    try {
      const result = await bridge.check();
      const latestVersion = result.latest?.version ?? null;
      const dismissed = get().dismissedVersion;
      const previousLatest = get().result?.latest?.version ?? null;
      const releaseChanged = latestVersion !== previousLatest;
      if (releaseChanged) clearDownloadWatchdog();

      set({
        checking: false,
        result,
        appVersion: result.currentVersion || get().appVersion,
        lastCheckedAt: Date.now(),
        errorCode: result.ok ? null : result.errorCode ?? 'server',
        detail: result.ok ? null : result.detail ?? null,
        // Progress from the previous offer must not leak onto a new version.
        ...(releaseChanged ? { download: null, downloadStarting: false, downloadError: null } : {}),
        // A new version only pops once per version: after the user closes the
        // dialog the offer lives in Settings until something newer ships.
        dialogOpen:
          result.ok && result.updateAvailable && latestVersion
            ? latestVersion !== dismissed
            : get().dialogOpen,
      });
    } catch (error) {
      set({
        checking: false,
        lastCheckedAt: Date.now(),
        errorCode: 'network',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  },

  dismissDialog: () => {
    const latest = get().result?.latest?.version ?? null;
    if (latest) {
      writeDismissedVersion(latest);
      set({ dialogOpen: false, dismissedVersion: latest });
      return;
    }
    set({ dialogOpen: false });
  },

  startDownload: async () => {
    const state = get();
    const latest = state.result?.latest;
    if (!latest?.downloadUrl) {
      set({ downloadError: 'failed' });
      return;
    }
    if (state.downloadStarting || state.download?.state === 'downloading') return;

    const bridge = window.electronAPI?.update;
    if (!bridge?.download) {
      set({ downloadError: 'unsupported' });
      return;
    }

    set({ downloadStarting: true, downloadError: null });
    attachProgressBridge(set);
    try {
      const start = await bridge.download(latest.downloadUrl, latest.fileName ?? undefined);
      if (!start.ok) {
        set({ downloadStarting: false, downloadError: start.error ?? 'failed' });
        return;
      }
      // Progress arrives through `onProgress`; seed the bar so it shows at once.
      set({ download: { state: 'downloading', received: 0, total: latest.fileSize ?? 0 } });
      clearDownloadWatchdog();
      downloadWatchdog = setTimeout(() => {
        const progress = get().download;
        if (!progress || (progress.state === 'downloading' && progress.received === 0)) {
          // Chromium never started the transfer (DNS/TLS/offline): fail visibly
          // instead of leaving the UI stuck at 0%.
          set({ download: null, downloadStarting: false, downloadError: 'failed' });
        }
        downloadWatchdog = null;
      }, DOWNLOAD_START_TIMEOUT_MS);
    } catch {
      set({ downloadStarting: false, downloadError: 'failed' });
    }
  },

  reveal: async () => {
    const progress = get().download;
    const path = progress?.state === 'completed' ? progress.path : null;
    if (!path) return;
    try {
      await window.electronAPI?.update?.reveal?.(path);
    } catch {
      // Revealing in the file manager is best-effort.
    }
  },
}));
