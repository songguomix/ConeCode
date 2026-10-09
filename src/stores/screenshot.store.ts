import { create } from 'zustand';

export interface ShotImage {
  dataUrl: string;
  width: number;
  height: number;
}

const SHORTCUT_KEY = 'conecode.screenshotShortcut';
export const DEFAULT_SCREENSHOT_SHORTCUT = 'CommandOrControl+Shift+S';

function loadShortcut(): string {
  try {
    const raw = localStorage.getItem(SHORTCUT_KEY);
    // null = never set → default; '' = explicitly disabled.
    if (raw == null) return DEFAULT_SCREENSHOT_SHORTCUT;
    return raw;
  } catch {
    return DEFAULT_SCREENSHOT_SHORTCUT;
  }
}

interface ScreenshotStore {
  /** Overlay visible. */
  open: boolean;
  /** Full-screen capture under the overlay. */
  image: ShotImage | null;
  /** Taking the capture now. */
  starting: boolean;
  /** Capture failure (permission / empty), cleared on close. */
  error: string | null;
  /** Global hotkey accelerator, '' = disabled. */
  shortcut: string;
  /** Capture the screen and open the overlay. */
  start: () => Promise<void>;
  close: () => void;
  /** Overlay window only: show pixels main grabbed (no capture from here). */
  openWithImage: (image: ShotImage) => void;
  /** Register a new global hotkey (or null/'' to disable). */
  applyShortcut: (accelerator: string | null) => Promise<boolean>;
  /** Boot: register the stored hotkey + listen for its trigger. */
  init: () => () => void;
}

export const useScreenshotStore = create<ScreenshotStore>((set, get) => ({
  open: false,
  image: null,
  starting: false,
  error: null,
  shortcut: loadShortcut(),

  start: async () => {
    if (get().starting) return;
    set({ starting: true, error: null });
    try {
      // WeChat-style: main hides the app, grabs clean pixels, and opens the
      // fullscreen overlay window. ok:true means the overlay took over (this
      // window hides); only failures land here as an in-app error card.
      const res = await (window as any).electronAPI?.screenshot?.begin?.();
      if (!res?.ok) {
        set({ open: true, image: null, error: res?.needsPermission ? 'permission' : 'failed', starting: false });
        return;
      }
      set({ starting: false });
    } catch {
      set({ open: true, image: null, error: 'failed', starting: false });
    }
  },

  close: () => set({ open: false, image: null, error: null }),

  openWithImage: (image) => set({ open: true, image, error: null, starting: false }),

  applyShortcut: async (accelerator) => {
    const acc = accelerator || null;
    try {
      const res = await (window as any).electronAPI?.screenshot?.setShortcut?.(acc);
      if (!res?.ok) return false;
    } catch {
      return false;
    }
    try {
      localStorage.setItem(SHORTCUT_KEY, acc || '');
    } catch {}
    set({ shortcut: acc || '' });
    return true;
  },

  init: () => {
    const { shortcut } = get();
    // Re-register the stored hotkey every launch (main forgets on quit).
    void (window as any).electronAPI?.screenshot?.setShortcut?.(shortcut || null);
    const off = (window as any).electronAPI?.screenshot?.onTrigger?.(() => {
      void get().start();
    });
    return () => off?.();
  },
}));
