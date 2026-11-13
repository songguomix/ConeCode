import { create } from 'zustand';
import type { ComputerStatus } from '../types/ipc.types';
import { describeAction, type ComputerFrame, type ComputerRequest } from '../core/computer/computer';

// Renderer-side state for letting the agent drive the real machine.
//
// The switch is deliberately not persisted. Handing an agent the mouse and
// keyboard is something the user should decide *now*, for this session — not
// something they turned on once weeks ago and forgot about. Every launch starts
// with it off.

export interface ComputerActivity {
  id: number;
  at: number;
  description: string;
  ok: boolean;
  detail?: string;
}

const MAX_ACTIVITY = 100;
let activitySeq = 0;
let statusEpoch = 0;
let statusRequest = 0;
let visibilityEpoch = 0;
let visibilityRequest = 0;

interface ComputerStore {
  enabled: boolean;
  supported: boolean;
  platform: string;
  accessibility: boolean;
  screenRecording: boolean;
  geometry: ComputerStatus['geometry'];
  target: ComputerStatus['target'];
  targetRevision: number;
  frameId: string | null;
  activity: ComputerActivity[];
  /** Most recent screenshot, so the panel can show what the agent is looking at. */
  lastShot: string | null;
  previewVisible: boolean;

  refresh: () => Promise<void>;
  subscribeStatus: () => () => void;
  refreshPreview: () => Promise<void>;
  setEnabled: (on: boolean) => Promise<void>;
  requestPermissions: () => Promise<void>;
  panic: () => Promise<void>;
  note: (req: ComputerRequest, ok: boolean, detail?: string) => void;
  setLastShot: (shot: ComputerFrame) => void;
  clearActivity: () => void;
}

const api = () => (window as any).electronAPI?.computer;

function scopedStatus(current: ComputerStore, status: ComputerStatus): Partial<ComputerStore> {
  return {
    ...status,
    ...(!status.enabled || status.targetRevision !== current.targetRevision || status.frameId !== current.frameId
      ? { lastShot: null } : {}),
  };
}

export const useComputerStore = create<ComputerStore>((set, get) => ({
  enabled: false,
  supported: false,
  platform: '',
  accessibility: false,
  screenRecording: false,
  geometry: null,
  target: null,
  targetRevision: 0,
  frameId: null,
  activity: [],
  lastShot: null,
  previewVisible: false,

  refresh: async () => {
    const request = ++statusRequest;
    const epoch = statusEpoch;
    const status: ComputerStatus | undefined = await api()?.status();
    if (status && epoch === statusEpoch && request === statusRequest) set(scopedStatus(get(), status));
  },

  subscribeStatus: () => {
    const offStatus = api()?.onStatus?.((status: ComputerStatus) => {
      statusEpoch += 1;
      set(scopedStatus(get(), status));
    });
    const offVisibility = api()?.onPreviewVisibility?.(({ visible }: { visible: boolean }) => {
      visibilityEpoch += 1;
      set({ previewVisible: visible });
    });
    return () => { offStatus?.(); offVisibility?.(); };
  },

  refreshPreview: async () => {
    const request = ++visibilityRequest;
    const epoch = visibilityEpoch;
    const result = await api()?.previewStatus?.();
    if (result && epoch === visibilityEpoch && request === visibilityRequest) set({ previewVisible: result.visible });
  },

  setEnabled: async (on: boolean) => {
    const request = ++statusRequest;
    const epoch = statusEpoch;
    const status: ComputerStatus | undefined = await api()?.setEnabled(on);
    if (status && epoch === statusEpoch && request === statusRequest) set(scopedStatus(get(), status));
  },

  requestPermissions: async () => {
    const request = ++statusRequest;
    const epoch = statusEpoch;
    const status: ComputerStatus | undefined = await api()?.requestPermissions();
    if (status && epoch === statusEpoch && request === statusRequest) set(scopedStatus(get(), status));
  },

  panic: async () => {
    const request = ++statusRequest;
    const epoch = statusEpoch;
    const status: ComputerStatus | undefined = await api()?.panic();
    if (status && epoch === statusEpoch && request === statusRequest) set({ ...status, lastShot: null });
  },

  note: (req, ok, detail) => set((s) => ({
    activity: [
      ...s.activity,
      { id: ++activitySeq, at: Date.now(), description: describeAction(req), ok, detail },
    ].slice(-MAX_ACTIVITY),
  })),

  setLastShot: (shot) => {
    const { enabled, frameId, target } = get();
    if (enabled && frameId === shot.frameId && target?.id === shot.target.id) set({ lastShot: shot.dataUrl });
  },
  clearActivity: () => set({ activity: [] }),
}));
