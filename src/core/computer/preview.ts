import type { ComputerActionName, ComputerFrame, ComputerTarget, DisplayGeometry, ScrollDirection } from './computer';

export const COMPUTER_PREVIEW_HASH = '#computer-preview';
export const COMPUTER_PREVIEW_CHANNELS = {
  open: 'computer-preview:open', state: 'computer-preview:state', getState: 'computer-preview:get-state',
  close: 'computer-preview:close', getVisibility: 'computer-preview:get-visibility', visibility: 'computer-preview:visibility-changed',
  act: 'computer-preview:act', refresh: 'computer-preview:refresh',
} as const;

export interface ComputerPreviewStatus {
  platform: string;
  enabled: boolean;
  supported: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  geometry: DisplayGeometry | null;
  target: ComputerTarget | null;
  targetRevision: number;
  frameId: string | null;
}

export interface ComputerPreviewSnapshot {
  revision: number;
  updatedAt: number;
  status: ComputerPreviewStatus;
  shot: (ComputerFrame & { capturedAt: number }) | null;
  pointer?: ComputerPreviewPointer | null;
  activity: Array<{ id: number; at: number; description: string; ok: boolean; detail?: string }>;
  /** Operations still in progress; emergency stop is not a rollback. */
  inFlight: number;
  appearance?: ComputerPreviewAppearance;
}

export type ComputerPreviewUpdate = Omit<ComputerPreviewSnapshot, 'shot'> & {
  /** The pixels are omitted when this frame was already sent to the preview. */
  shot: (Omit<NonNullable<ComputerPreviewSnapshot['shot']>, 'dataUrl'> & { dataUrl?: string }) | null;
};

export interface ComputerPreviewAppearance {
  locale: 'en' | 'zh' | 'zhHant' | 'ja';
  theme: 'light' | 'dark';
}

export interface ComputerPreviewPointer {
  id: number;
  frameId: string;
  coordinate: [number, number];
  action: ComputerActionName;
  phase: 'pending' | 'sent';
  source?: 'agent' | 'manual';
}

export type ComputerPreviewInput = { frameId: string } & (
  | { action: 'left_click' | 'right_click'; coordinate: [number, number] }
  | { action: 'scroll'; coordinate: [number, number]; scroll_direction: ScrollDirection; scroll_amount: number }
  | { action: 'type'; text: string }
);

export interface ComputerPreviewCommandResult {
  ok: boolean;
  message: string;
  warning?: string;
}

export interface ComputerPreviewAPI {
  getState(): Promise<ComputerPreviewSnapshot>;
  onState(callback: (state: ComputerPreviewUpdate) => void): () => void;
  act(input: ComputerPreviewInput): Promise<ComputerPreviewCommandResult>;
  refresh(targetRevision: number): Promise<ComputerPreviewCommandResult>;
}

export function isComputerPreviewWindowHash(hash: string): boolean {
  return hash === COMPUTER_PREVIEW_HASH || hash === `${COMPUTER_PREVIEW_HASH}/`;
}
