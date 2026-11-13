import type { UpdateDownloadError } from '../../stores/update.store';
import type { UpdateErrorCode } from '../../core/updates/updateClient';

type Translate = (key: string) => string;

const CHECK_ERROR_KEYS: Record<UpdateErrorCode, string> = {
  network: 'updateErrorNetwork',
  timeout: 'updateErrorTimeout',
  http: 'updateErrorHttp',
  'invalid-json': 'updateErrorInvalidJson',
  server: 'updateErrorServer',
  unavailable: 'updateErrorUnavailable',
  'unsupported-platform': 'updateNoCompatibleRelease',
};

const DOWNLOAD_ERROR_KEYS: Record<UpdateDownloadError, string> = {
  blocked: 'updateDownloadBlocked',
  busy: 'updateDownloadBusy',
  failed: 'updateDownloadFailed',
  unsupported: 'updateDownloadUnsupported',
};

export function updateErrorMessage(t: Translate, code: UpdateErrorCode | null): string {
  return t(code ? CHECK_ERROR_KEYS[code] : 'updateErrorServer');
}

export function updateDownloadErrorMessage(t: Translate, code: UpdateDownloadError | null): string {
  return t(code ? DOWNLOAD_ERROR_KEYS[code] : 'updateDownloadFailed');
}

/** Shared progress math: percentage when the server sends a total size. */
export function downloadPercent(received: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((received / total) * 100)));
}

export function formatReleaseDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
