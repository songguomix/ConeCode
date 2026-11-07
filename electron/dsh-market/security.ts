import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import semver from 'semver';
import type { MarketVersionSource } from '../../src/core/dsh-market/types';

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Anything that can become an argv token must not start with an option flag. */
function assertArgvSafe(value: string, label: string): void {
  if (!value || value.startsWith('-') || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} is not a safe package spec`);
  }
  // On Windows the npm shim is launched through cmd.exe, so do not admit
  // characters that cmd would treat as syntax. macOS/Linux spawn argv directly.
  if (process.platform === 'win32' && /[&|;<>()$`"']/.test(value)) {
    throw new Error(`${label} contains characters that are unsafe for the Windows npm launcher`);
  }
}

export function validatePackageName(name: string): string {
  const value = name.trim();
  if (value.length > 214 || !PACKAGE_NAME.test(value)) throw new Error(`Invalid npm package name: ${JSON.stringify(name)}`);
  return value;
}

export function validateExactVersion(version: string): string {
  if (!semver.valid(version) || version !== version.trim()) {
    throw new Error(`Expected an exact semantic version, got ${JSON.stringify(version)}`);
  }
  return version;
}

export function validateProfileId(id: string): string {
  if (!PROFILE_ID.test(id)) throw new Error('Profile id must be 1–32 lowercase letters, numbers, "-" or "_".');
  return id;
}

export function validateRegistryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid registry URL: ${value}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
    throw new Error('Registry URL must use https (http is allowed only for localhost).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Registry URL must not contain credentials, a query or a fragment.');
  }
  return url.toString().replace(/\/$/, '');
}

export function validateGitUrl(value: string): { url: string; commit: string } {
  const raw = value.replace(/^git\+/, '');
  const hashIndex = raw.lastIndexOf('#');
  if (hashIndex <= 0) throw new Error('Git sources must pin an exact 40-character commit.');
  const urlPart = raw.slice(0, hashIndex);
  const commit = raw.slice(hashIndex + 1).split('&')[0];
  if (!COMMIT.test(commit)) throw new Error('Git sources must pin an exact lowercase 40-character commit.');
  let url: URL;
  try {
    url = new URL(urlPart);
  } catch {
    throw new Error('Git source must be an absolute https URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Git source must be a canonical https URL without credentials, query or fragment.');
  }
  return { url: url.toString().replace(/\.git$/, ''), commit };
}

export function buildInstallSpec(name: string, version: string, source: MarketVersionSource): { spec: string; registry?: string } {
  validatePackageName(name);
  validateExactVersion(version);
  if (source.registry) validateRegistryUrl(source.registry);
  if (source.type === 'npm') {
    const spec = `${source.packageName || name}@${version}`;
    assertArgvSafe(spec, 'npm spec');
    return { spec, registry: source.registry };
  }
  if (source.type === 'git') {
    if (!source.url) throw new Error('Git source is missing its URL.');
    const validated = validateGitUrl(`${source.url}#${source.commit || ''}`);
    const subdir = source.subdir?.replace(/\\/g, '/').replace(/^\.\//, '');
    if (subdir && (subdir.startsWith('/') || subdir.split('/').includes('..') || /[\0\r\n]/.test(subdir))) {
      throw new Error('Git package subdirectory must be a relative path inside the repository.');
    }
    const spec = `git+${validated.url}.git#${validated.commit}${subdir ? `&path:/${subdir}` : ''}`;
    assertArgvSafe(spec, 'git spec');
    return { spec };
  }
  if (source.type === 'local') {
    if (!source.path) throw new Error('Local source is missing its path.');
    const resolved = path.resolve(source.path);
    if (!fs.existsSync(resolved)) throw new Error(`Local plugin source does not exist: ${resolved}`);
    const spec = `file:${resolved}`;
    assertArgvSafe(spec, 'local spec');
    return { spec };
  }
  if (source.type === 'bundled-example') {
    if (!source.path) throw new Error('Bundled example source is missing its path.');
    return { spec: `example:${path.resolve(source.path)}` };
  }
  throw new Error(`Unsupported source type: ${(source as { type?: string }).type}`);
}

/** Reject paths whose real location is outside the allowed root. */
function realpathLoose(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}

export function assertInside(root: string, candidate: string, label: string): string {
  const realRoot = fs.realpathSync(root);
  const real = realpathLoose(candidate);
  const relative = path.relative(realRoot, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${realRoot}`);
  }
  return real;
}

export function pluginDirectoryName(name: string): string {
  const slug = name.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 10);
  return `${slug || 'plugin'}-${hash}`;
}

export function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value;
  }
}

export function normalizeUserInputUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('URL is empty');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Enter an absolute http(s) URL.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
    throw new Error('Catalog sources must use https (http is allowed only for localhost).');
  }
  if (url.username || url.password) throw new Error('Catalog URL must not contain credentials.');
  url.hash = '';
  return url.toString();
}

/** A registry URL is safe to show in errors only after credentials are removed. */
export function registryLabel(registry?: string): string {
  return registry ? redactUrl(registry) : 'npm default registry';
}
