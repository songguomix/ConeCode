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
export type UpdateStatus = 'ok' | 'no_update' | 'no_compatible_release' | 'error';
export type UpdateErrorCode =
  | 'unsupported-platform'
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
export function resolvePlatform(raw: unknown): UpdatePlatform | null {
  if (typeof raw !== 'string') return null;
  const label = raw.trim().toLowerCase();
  if (['darwin', 'macos', 'mac', 'osx', 'apple', 'mac os'].includes(label)) return 'macos';
  if (['win32', 'win64', 'win', 'windows'].includes(label)) return 'windows';
  if (['linux', 'ubuntu', 'debian', 'appimage'].includes(label)) return 'linux';
  return null;
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
  const platform = resolvePlatform(options.platform);
  if (!platform) throw new Error('Unsupported update platform');
  url.searchParams.set('platform', platform);
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

const INSTALLER_EXTENSIONS: Record<UpdatePlatform, RegExp> = {
  macos: /\.dmg$/i,
  windows: /\.exe$/i,
  linux: /\.appimage$/i,
};

function resolveArchitecture(value: string): string {
  const arch = value.trim().toLowerCase();
  if (arch === 'amd64' || arch === 'x86_64') return 'x64';
  if (arch === 'aarch64') return 'arm64';
  if (arch === 'x86' || /^i[3-6]86$/.test(arch)) return 'ia32';
  return arch;
}

function isCompatibleRelease(
  source: Record<string, unknown>,
  release: UpdateRelease,
  platform: UpdatePlatform,
  arch?: string,
): boolean {
  if (release.platform && resolvePlatform(release.platform) !== platform) return false;

  const extension = INSTALLER_EXTENSIONS[platform];
  const path = release.downloadUrl ? new URL(release.downloadUrl).pathname : '';
  let urlName = path.slice(path.lastIndexOf('/') + 1);
  try {
    urlName = decodeURIComponent(urlName);
  } catch {
    return false;
  }
  // An API download URL can be opaque. When it names an installer, check it
  // as well as the server's fileName, since the two can disagree.
  const directInstaller = /\.(?:dmg|exe|appimage|msi|pkg|deb|rpm|zip|tar\.gz)$/i.test(urlName);
  const names = [release.fileName, directInstaller ? urlName : null].filter((name): name is string => Boolean(name));
  if (names.some((name) => !extension.test(name))) return false;
  if (names.length === 0 && (!release.platform || arch)) return false;
  if (!arch) return true;

  const declaredArch = pickString(source, 'arch', 'architecture');
  const architectures = declaredArch ? [resolveArchitecture(declaredArch)] : [];
  for (const name of names) {
    const matches = name.matchAll(/(?:^|[._ -])(arm64|aarch64|x64|amd64|x86_64|ia32|x86|i[3-6]86|armv7l|armv7|armhf|riscv64|universal)(?=$|[._ -])/gi);
    for (const match of matches) architectures.push(resolveArchitecture(match[1]));
  }
  // The published NSIS and AppImage x64 artifacts omit architecture in their
  // names. Other architectures must be explicit in the metadata or filename.
  if (architectures.length === 0) return platform !== 'macos' && arch === 'x64';
  return architectures.every((candidate) => candidate === arch ||
    (platform === 'macos' && candidate === 'universal' && (arch === 'x64' || arch === 'arm64')));
}

/** Normalize the `/update` payload. Never throws on malformed input. */
export function parseUpdatePayload(
  payload: unknown,
  currentVersion: string,
  platform?: unknown,
  arch?: string,
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
  if (!latestSource || !parsedLatest) {
    if (statusRaw === 'no_update') {
      return { ok: true, status: 'no_update', updateAvailable: false, currentVersion, latest: null };
    }
    return failureResult(currentVersion, 'invalid-json', 'Update payload has no release information');
  }

  let latest = parsedLatest;
  let substituted = false;
  if (platform != null) {
    const clientPlatform = resolvePlatform(platform);
    if (!clientPlatform) return failureResult(currentVersion, 'unsupported-platform', 'Unsupported update platform');
    if (!isCompatibleRelease(latestSource, latest, clientPlatform, arch)) {
      const alternatives = root.all_platforms ?? root.allPlatforms;
      let match: UpdateRelease | null = null;
      if (Array.isArray(alternatives)) {
        for (const entry of alternatives) {
          const record = asRecord(entry);
          const candidate = record && parseRelease(record);
          if (!record || !candidate?.downloadUrl || !isCompatibleRelease(record, candidate, clientPlatform, arch)) continue;
          if (!match || compareVersions(candidate.version, match.version) > 0) match = candidate;
        }
      }
      if (!match) {
        return { ok: true, status: 'no_compatible_release', updateAvailable: false, currentVersion, latest: null };
      }
      latest = match;
      substituted = true;
    }
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
  arch?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateCheckResult> {
  const currentVersion = (options.currentVersion || '').replace(/^v/i, '');
  if (!resolvePlatform(options.platform)) {
    return failureResult(currentVersion, 'unsupported-platform', 'Unsupported update platform');
  }
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
    return parseUpdatePayload(payload, currentVersion, options.platform, options.arch);
  } catch (error) {
    const { code, detail } = describeFetchError(error);
    return failureResult(currentVersion, code, detail);
  } finally {
    clearTimeout(timer);
  }
}
