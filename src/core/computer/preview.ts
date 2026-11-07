import type { DisplayGeometry } from './computer';

export const COMPUTER_PREVIEW_HASH = '#computer-preview';
export const COMPUTER_PREVIEW_CHANNELS = {
  open: 'computer-preview:open', state: 'computer-preview:state', getState: 'computer-preview:get-state',
  close: 'computer-preview:close', getVisibility: 'computer-preview:get-visibility', visibility: 'computer-preview:visibility-changed',
} as const;

export interface ComputerPreviewStatus {
  platform: string;
  enabled: boolean;
  supported: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  geometry: DisplayGeometry | null;
}

export interface ComputerPreviewSnapshot {
  revision: number;
  updatedAt: number;
  status: ComputerPreviewStatus;
  shot: { dataUrl: string; capturedAt: number; geometry: DisplayGeometry } | null;
  activity: Array<{ id: number; at: number; description: string; ok: boolean; detail?: string }>;
  /** Operations still in progress; emergency stop is not a rollback. */
  inFlight: number;
  appearance?: ComputerPreviewAppearance;
}

export interface ComputerPreviewAppearance {
  locale: 'en' | 'zh' | 'zhHant' | 'ja';
  theme: 'light' | 'dark';
}

export interface ComputerPreviewAPI {
  getState(): Promise<ComputerPreviewSnapshot>;
  onState(callback: (state: ComputerPreviewSnapshot) => void): () => void;
}

export function isComputerPreviewWindowHash(hash: string): boolean {
  return hash === COMPUTER_PREVIEW_HASH || hash === `${COMPUTER_PREVIEW_HASH}/`;
}
