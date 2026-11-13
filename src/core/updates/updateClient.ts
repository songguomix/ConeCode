/**
 * Update check + download-metadata client for ConeCode.
 *
 * The release metadata comes from `https://agibase.dev/update` — the same JSON
 * contract the agibase download page uses (`?format=json`).
 *
 * Everything in that payload is untrusted data. We normalize it into a small
 * typed record and the UI only renders its fields as plain text: the
 * server-provided `notes_html` is deliberately ignored so a compromised or
 * malformed endpoint can never inject markup into the renderer.
 */

export const DEFAULT_UPDATE_BASE_URL = 'https://agibase.dev';
export const UPDATE_PRODUCT_SLUG = 'conecode';
export const UPDATE_TIMEOUT_MS = 12_000;

export type UpdatePlatform = 'macos' | 'windows' | 'linux';
export type UpdateStatus = 'ok' | 'no_update' | 'error';
export type UpdateErrorCode =
  | 'unavailable'
  | 'network'
  | 'timeout'
  | 'http'
  | 'invalid-json'
  | 'server';

export interface UpdateRelease {
  version: string;
  platform: string | null;
  fileName: string | null;
  fileSize: number | null;
  fileSizeLabel: string | null;
  sha256: string | null;
  summary: string;
  changelogItems: string[];
  publishedAt: string | null;
  downloadUrl: string | null;
}

export interface UpdateCheckResult {
  ok: boolean;
  status: UpdateStatus;
  updateAvailable: boolean;
  currentVersion: string;
  latest: UpdateRelease | null;
  errorCode?: UpdateErrorCode;
  detail?: string;
}

/** Progress messages pushed from the main process while an installer downloads. */
export type UpdateDownloadProgress =
  | { state: 'downloading'; received: number; total: number }
  | { state: 'completed'; received: number; total: number; path: string }
  | { state: 'error'; message: string };

export interface UpdateDownloadStart {
  ok: boolean;
  error?: 'blocked' | 'busy' | 'failed';
}

/** Hosts we are willing to download an installer from. */
export const ALLOWED_UPDATE_DOWNLOAD_HOSTS = [
  'agibase.dev',
  'www.agibase.dev',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

const MAX_CHANGELOG_ITEMS = 12;
const MAX_TEXT_LENGTH = 4_000;

interface ParsedVersion {
  nums: number[];
  pre: string | null;
}

function parseVersion(raw: string): ParsedVersion {
  const clean = raw.trim().replace(/^v/i, '');
  const dash = clean.indexOf('-');
  const core = dash === -1 ? clean : clean.slice(0, dash);
  const pre = dash === -1 ? null : clean.slice(dash + 1).toLowerCase() || null;
  const nums = core.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return { nums, pre };
}

/** Semver-ish comparison: `1` when a > b, `-1` when a < b, `0` when equal. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < len; i += 1) {
    const x = va.nums[i] ?? 0;
    const y = vb.nums[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  if (va.pre === vb.pre) return 0;
  // A release build outranks its own pre-release (2.5.0 > 2.5.0-beta.1).
  if (va.pre === null) return 1;
  if (vb.pre === null) return -1;
  return va.pre > vb.pre ? 1 : -1;
}

/** Map `process.platform` / release platform labels onto the API's words. */
export function resolvePlatform(raw: unknown): UpdatePlatform {
  const s = String(raw ?? '').toLowerCase().trim();
  if (s.includes('darwin') || s.includes('mac') || s.includes('osx') || s.includes('apple')) return 'macos';
  if (s.includes('win')) return 'windows';
  if (s.includes('linux') || s.includes('ubuntu') || s.includes('debian') || s.includes('appimage')) return 'linux';
  return 'linux';
}

export function buildUpdateUrl(options: {
  baseUrl?: string;
  product?: string;
  currentVersion: string;
  platform: unknown;
}): string {
  const base = (options.baseUrl || DEFAULT_UPDATE_BASE_URL).trim();
  const url = new URL(base.endsWith('/') ? base : `${base}/`);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/update`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('product', options.product || UPDATE_PRODUCT_SLUG);
  url.searchParams.set('platform', resolvePlatform(options.platform));
  url.searchParams.set('version', options.currentVersion || '0.0.0');
  url.searchParams.set('format', 'json');
  return url.toString();
}

export function formatFileSize(bytes: number | null): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

export function isAllowedDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_UPDATE_DOWNLOAD_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickString(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pickNumber(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/** Strip markdown/HTML noise so notes render as readable plain text. */
export function toPlainText(raw: string): string {
  return raw
    .replace(/<(?:br|\/p|\/li|\/div)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function toChangelogItems(raw: unknown, fallbackText: string): string[] {
  const items: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry.trim()) items.push(entry);
    }
  }
  if (items.length === 0 && fallbackText) {
    items.push(...fallbackText.split(/\r?\n/));
  }
  const cleaned = items
    .map((line) => toPlainText(line.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '').replace(/^#{1,6}\s*/, '')))
    .filter((line) => line.length > 0);
  return cleaned.slice(0, MAX_CHANGELOG_ITEMS);
}

function parseRelease(source: Record<string, unknown>): UpdateRelease | null {
  const version = pickString(source, 'version', 'tag_name', 'latest_version');
  if (!version) return null;

  const notes = toPlainText(pickString(source, 'changelog', 'notes', 'body', 'summary'));
  const changelogItems = toChangelogItems(source.changelog_items ?? source.changelogItems, notes);
  const summary = toPlainText(pickString(source, 'summary', 'tagline')) || changelogItems[0] || notes;

  const rawSize = pickNumber(source, 'fileSize', 'file_size', 'size');
  const downloadRaw = pickString(source, 'downloadUrl', 'download_url', 'url');
  const downloadUrl = downloadRaw && isAllowedDownloadUrl(downloadRaw) ? downloadRaw : null;

  const publishedRaw = pickString(source, 'publishedAtIso', 'published_at_iso', 'pub_date', 'publishedAt');
  let publishedAt: string | null = publishedRaw || null;
  if (!publishedAt) {
    const epoch = pickNumber(source, 'publishedAt', 'published_at');
    if (epoch && epoch > 0) publishedAt = new Date(epoch > 1e12 ? epoch : epoch * 1000).toISOString();
  }

  return {
    version: version.replace(/^v/i, ''),
    platform: pickString(source, 'platform') || null,
    fileName: pickString(source, 'fileName', 'file_name') || null,
    fileSize: rawSize,
    fileSizeLabel: pickString(source, 'fileSizeFormatted', 'file_size_formatted') || formatFileSize(rawSize),
    sha256: pickString(source, 'sha256', 'signature') || null,
    summary,
    changelogItems,
    publishedAt,
    downloadUrl,
  };
}

export function failureResult(
  currentVersion: string,
  errorCode: UpdateErrorCode,
  detail: string,
): UpdateCheckResult {
  return {
    ok: false,
    status: 'error',
    updateAvailable: false,
    currentVersion,
    latest: null,
    errorCode,
    detail,
  };
}

/**
 * When the server cannot find an installer for our platform it falls back to
 * the first published release (`productReleases[0]`) — i.e. a macOS `.dmg` for
 * a Linux client. Prefer the matching entry from `all_platforms`, and if there
 * is none, report "up to date" rather than offering an uninstallable file.
 */
function releaseForPlatform(
  root: Record<string, unknown>,
  latest: UpdateRelease,
  platform: unknown,
): { release: UpdateRelease | null; substituted: boolean } {
  if (platform === undefined || platform === null) return { release: latest, substituted: false };
  const clientPlatform = resolvePlatform(platform);
  if (!latest.platform || resolvePlatform(latest.platform) === clientPlatform) {
    return { release: latest, substituted: false };
  }

  const alternatives = root.all_platforms ?? root.allPlatforms;
  if (Array.isArray(alternatives)) {
    for (const entry of alternatives) {
      const record = asRecord(entry);
      if (!record) continue;
      if (!pickString(record, 'platform') || resolvePlatform(record.platform) !== clientPlatform) continue;
      const match = parseRelease(record);
      if (match) return { release: match, substituted: true };
    }
  }
  return { release: null, substituted: true };
}

/** Normalize the `/update` payload. Never throws on malformed input. */
export function parseUpdatePayload(
  payload: unknown,
  currentVersion: string,
  platform?: unknown,
): UpdateCheckResult {
  const root = asRecord(payload);
  if (!root) return failureResult(currentVersion, 'invalid-json', 'Update payload is not an object');

  const statusRaw = pickString(root, 'status').toLowerCase();
  if (statusRaw === 'error') {
    return failureResult(currentVersion, 'server', pickString(root, 'message', 'error') || 'Server reported an error');
  }

  const latestSource = (() => {
    const direct = asRecord(root.latest) || asRecord(root.release);
    if (direct) return direct;
    const products = asRecord(root.products);
    if (!products) return null;
    for (const value of Object.values(products)) {
      const product = asRecord(value);
      const candidate = product ? asRecord(product.latest) || asRecord(product.release) : null;
      if (candidate) return candidate;
    }
    return null;
  })();

  const parsedLatest = latestSource ? parseRelease(latestSource) : null;
  // The server answers `no_update` with no release object when a product has
  // nothing published yet — that is "up to date", not a broken payload.
  if (!parsedLatest) {
    if (statusRaw === 'no_update') {
      return { ok: true, status: 'no_update', updateAvailable: false, currentVersion, latest: null };
    }
    return failureResult(currentVersion, 'invalid-json', 'Update payload has no release information');
  }

  const { release: latest, substituted } = releaseForPlatform(root, parsedLatest, platform);
  if (!latest) {
    // Nothing installable on this machine.
    return { ok: true, status: 'no_update', updateAvailable: false, currentVersion, latest: null };
  }

  const availableFlag = root.update_available ?? root.updateAvailable;
  const updateAvailable =
    !substituted && typeof availableFlag === 'boolean'
      ? availableFlag && compareVersions(latest.version, currentVersion) > 0
      : compareVersions(latest.version, currentVersion) > 0;

  return {
    ok: true,
    status: updateAvailable ? 'ok' : 'no_update',
    updateAvailable,
    currentVersion,
    latest,
  };
}

function describeFetchError(error: unknown): { code: UpdateErrorCode; detail: string } {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return { code: 'timeout', detail: 'Request timed out' };
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return { code: 'network', detail: code ? `${error.message} (${code})` : error.message };
  }
  return { code: 'network', detail: String(error) };
}

export interface CheckForUpdateOptions {
  baseUrl?: string;
  product?: string;
  currentVersion: string;
  platform: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateCheckResult> {
  const currentVersion = (options.currentVersion || '').replace(/^v/i, '');
  const fetchImpl = options.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined);
  if (!fetchImpl) return failureResult(currentVersion, 'unavailable', 'No fetch implementation available');

  const timeoutMs = options.timeoutMs ?? UPDATE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(
      buildUpdateUrl({
        baseUrl: options.baseUrl,
        product: options.product,
        currentVersion,
        platform: options.platform,
      }),
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': options.userAgent || `ConeCode/${currentVersion || '0.0.0'}`,
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      return failureResult(currentVersion, 'http', `HTTP ${response.status}`);
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return failureResult(currentVersion, 'invalid-json', 'Response is not valid JSON');
    }
    return parseUpdatePayload(payload, currentVersion, options.platform);
  } catch (error) {
    const { code, detail } = describeFetchError(error);
    return failureResult(currentVersion, code, detail);
  } finally {
    clearTimeout(timer);
  }
}
