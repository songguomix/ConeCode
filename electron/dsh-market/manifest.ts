import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { parse as parseYaml } from 'yaml';
import {
  DSH_COMPAT_LAYER_VERSION,
  type CompatibilityReason,
  type CompatibilityResult,
  type DshBaseline,
  type DshRuntimeEnvironment,
  type InstalledRow,
  type MissingCapability,
  type PluginVerification,
} from '../../src/core/dsh-market/types';

export interface RawPackageManifest {
  name?: string;
  version?: string;
  description?: string;
  author?: string | { name?: string };
  license?: string;
  homepage?: string;
  icon?: string;
  main?: string;
  module?: string;
  type?: string;
  exports?: unknown;
  files?: string[];
  keywords?: string[];
  engines?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  dsh?: Record<string, unknown>;
  conecode?: Record<string, unknown>;
  repository?: string | { type?: string; url?: string; directory?: string };
  [key: string]: unknown;
}

export interface BundlePatchRow {
  id: string;
  name: string;
  config?: unknown;
  disabled?: boolean;
  inject?: string[];
  group?: boolean;
  [key: string]: unknown;
}

export interface LoadedBundlePatch {
  files: string[];
  rows: BundlePatchRow[];
  patches: Array<Record<string, unknown>>;
  warnings: string[];
}

export function readJSONFile<T = unknown>(filename: string): T {
  return JSON.parse(fs.readFileSync(filename, 'utf8')) as T;
}

export function readPackageManifest(packageDir: string): RawPackageManifest {
  const filename = path.join(packageDir, 'package.json');
  if (!fs.existsSync(filename)) throw new Error(`package.json not found in ${packageDir}`);
  const manifest = readJSONFile<RawPackageManifest>(filename);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${filename} must contain a JSON object`);
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    throw new Error(`${filename}: name must be a non-empty string`);
  }
  if (typeof manifest.version !== 'string' || !semver.valid(manifest.version)) {
    throw new Error(`${filename}: version must be an exact semantic version`);
  }
  return manifest;
}

export function bundlePatchFiles(packageDir: string, manifest: RawPackageManifest): string[] {
  const dsh = manifest.dsh;
  if (!dsh || typeof dsh !== 'object' || Array.isArray(dsh)) {
    throw new Error('package.json declares no dsh.bundle; this is not a DSH plugin bundle');
  }
  const bundle = dsh.bundle;
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('package.json declares no dsh.bundle; this is not a DSH plugin bundle');
  }
  const declared = (bundle as Record<string, unknown>).patch;
  const files = typeof declared === 'string' ? [declared] : declared;
  if (!Array.isArray(files) || files.length === 0 || !files.every((file) => typeof file === 'string' && file.trim())) {
    throw new Error('dsh.bundle.patch must be a file path or a non-empty list of file paths');
  }
  if (files.length > 16) throw new Error('dsh.bundle.patch lists more than 16 files');
  const root = fs.realpathSync(packageDir);
  return files.map((file) => {
    const resolved = path.resolve(root, file);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`dsh.bundle.patch ${JSON.stringify(file)} escapes the package directory`);
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`dsh.bundle.patch ${JSON.stringify(file)} is missing`);
    }
    if (fs.statSync(resolved).size > 2 * 1024 * 1024) {
      throw new Error(`dsh.bundle.patch ${JSON.stringify(file)} exceeds 2 MiB`);
    }
    return resolved;
  });
}

/**
 * Apply DSH loader patch verbs. This mirrors the semantics documented by
 * `@deepseek-ai/cordis-plugin-include` 1.1.0 for the subset ConeCode loads:
 * root inserts and id-targeted whole-key overrides. Native includes/groups and
 * `!!js` expressions are rejected explicitly instead of being guessed.
 */
export function applyEntryPatches(
  data: BundlePatchRow[],
  patches: Array<Record<string, unknown>>,
  warn: (message: string) => void,
): BundlePatchRow[] {
  const entries = structuredClone(data);
  const byId = new Map<string, BundlePatchRow>();
  const build = (rows: BundlePatchRow[]) => {
    for (const row of rows) {
      if (row.id) byId.set(row.id, row);
      if (row.group && Array.isArray(row.config)) build(row.config as unknown as BundlePatchRow[]);
    }
  };
  build(entries);

  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch;
    if (insert !== undefined) {
      if (id !== undefined) {
        // Nested inserts need group semantics; refuse rather than mounting the
        // children at the wrong level.
        warn(`patch insert into ${String(id)} is not supported by this compatibility layer`);
        continue;
      }
      if (!Array.isArray(insert)) {
        warn('patch insert must be an array');
        continue;
      }
      const clone = structuredClone(insert) as BundlePatchRow[];
      entries.push(...clone);
      build(clone);
      continue;
    }
    if (typeof id !== 'string' || !id) {
      warn('patch id is required for non-insert patches');
      continue;
    }
    const target = byId.get(id);
    if (!target) {
      warn(`patch target ${JSON.stringify(id)} was not found`);
      continue;
    }
    if (typeof name === 'string' && name !== target.name) {
      warn(`patch name mismatch for ${JSON.stringify(id)}`);
      continue;
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'id') continue;
      (target as Record<string, unknown>)[key] = value;
    }
  }
  return entries;
}

export function loadBundlePatches(packageDir: string, manifest: RawPackageManifest): LoadedBundlePatch {
  const files = bundlePatchFiles(packageDir, manifest);
  const warnings: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let value: unknown;
    try {
      value = parseYaml(text);
    } catch (error) {
      throw new Error(`${file}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(value)) {
      throw new Error(`${file}: a bundle patch must be a top-level YAML array`);
    }
    for (const patch of value) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error(`${file}: every patch entry must be an object`);
      }
      patches.push(patch as Record<string, unknown>);
    }
  }
  const rows = applyEntryPatches([], patches, (message) => warnings.push(message));
  const normalized: BundlePatchRow[] = [];
  for (const row of rows) {
    if (row.group === true) {
      throw new Error(`plugin row ${JSON.stringify(row.id ?? row.name)} uses a Cordis group, which this layer does not mount`);
    }
    if (typeof row.name !== 'string' || !row.name.trim()) {
      throw new Error(`plugin row ${JSON.stringify(row.id)} has no module name`);
    }
    if (row.disabled && typeof row.disabled === 'object') {
      throw new Error(`plugin row ${JSON.stringify(row.id)} uses a dynamic !!js disabled expression; refusing to guess its value`);
    }
    const id = typeof row.id === 'string' && row.id ? row.id : `${row.name}#${normalized.length + 1}`;
    normalized.push({
      ...row,
      id,
      name: row.name,
      disabled: row.disabled === true,
      inject: Array.isArray(row.inject) ? row.inject.filter((x): x is string => typeof x === 'string') : undefined,
    });
  }
  return { files, rows: normalized, patches, warnings };
}

function conditionTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = conditionTarget(item);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['import', 'node', 'default', 'require']) {
      if (key in record) {
        const found = conditionTarget(record[key]);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function subpathExport(exportsField: unknown, subpath: string): string | undefined {
  if (!exportsField) return undefined;
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    return subpath === '.' ? conditionTarget(exportsField) : undefined;
  }
  if (typeof exportsField !== 'object') return undefined;
  const record = exportsField as Record<string, unknown>;
  if (!Object.keys(record).some((key) => key.startsWith('.'))) {
    return subpath === '.' ? conditionTarget(record) : undefined;
  }
  return conditionTarget(record[subpath]);
}

function moduleFile(base: string): string | undefined {
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js'), path.join(base, 'index.mjs')];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Resolve a package root or exported subpath without executing plugin code. */
export function resolvePackageEntry(packageDir: string, subpath = '.'): string {
  const manifest = readPackageManifest(packageDir);
  const root = fs.realpathSync(packageDir);
  const target = subpathExport(manifest.exports, subpath);
  if (target) {
    const resolved = moduleFile(path.resolve(root, target));
    if (!resolved) throw new Error(`${manifest.name}: export ${subpath} points to a missing file`);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`${manifest.name}: export ${subpath} escapes the package directory`);
    }
    return resolved;
  }
  if (subpath !== '.') throw new Error(`${manifest.name}: no export named ${subpath}`);
  const main = manifest.module || manifest.main || 'index.js';
  const resolved = moduleFile(path.resolve(root, main));
  if (!resolved) throw new Error(`${manifest.name}: entry ${JSON.stringify(main)} does not exist`);
  return resolved;
}

export function resolveRowModule(packageDir: string, packageName: string, rowName: string): string {
  if (rowName === packageName) return resolvePackageEntry(packageDir, '.');
  if (rowName.startsWith(`${packageName}/`)) {
    return resolvePackageEntry(packageDir, `.${rowName.slice(packageName.length)}`);
  }
  // Another package is a legitimate Loader row. Resolve it through Node from
  // the bundle's own directory so dependencies remain authoritative.
  try {
    const require = createRequire(path.join(packageDir, '__conecode_resolve__.cjs'));
    return require.resolve(rowName);
  } catch (error) {
    throw new Error(`cannot resolve row module ${JSON.stringify(rowName)} from ${packageDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function manifestAuthor(manifest: RawPackageManifest): string | undefined {
  if (typeof manifest.author === 'string') return manifest.author;
  if (manifest.author && typeof manifest.author === 'object' && typeof manifest.author.name === 'string') {
    return manifest.author.name;
  }
  return undefined;
}

export function manifestRepository(manifest: RawPackageManifest): { url: string; directory?: string } | undefined {
  const value = manifest.repository;
  let raw: string | undefined;
  let directory: string | undefined;
  if (typeof value === 'string') raw = value;
  else if (value && typeof value === 'object') {
    raw = typeof value.url === 'string' ? value.url : undefined;
    directory = typeof value.directory === 'string' ? value.directory : undefined;
  }
  if (!raw) return undefined;
  const normalized = raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');
  if (/^https?:\/\//.test(normalized)) return { url: normalized, directory };
  const match = normalized.match(/^github:([^/]+)\/(.+)$/);
  if (match) return { url: `https://github.com/${match[1]}/${match[2]}`, directory };
  return undefined;
}

export interface DshRequirementResult {
  authoredRange: string | null;
  authoredKeys: string[];
  requirements: Record<string, string>;
}

function parseRequirementObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Plugin manifest ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function evaluateDshRequirements(
  manifest: RawPackageManifest,
  runtimeVersion: string,
): DshRequirementResult {
  const engines = parseRequirementObject(manifest.engines, 'engines');
  const requirements: Record<string, string> = {};
  const authoredKeys: string[] = [];
  let authoredRange: string | null = null;

  if (Object.prototype.hasOwnProperty.call(engines, 'dsh')) {
    const range = engines.dsh;
    if (typeof range !== 'string') throw new Error('Plugin manifest engines.dsh must be a string');
    authoredRange = range;
    authoredKeys.push('engines.dsh');
    const valid = range.trim() !== '' && !range.startsWith('workspace:') && semver.satisfies(runtimeVersion, range, { includePrerelease: true });
    if (!valid) requirements['engines.dsh'] = range;
    return { authoredRange, authoredKeys, requirements };
  }

  const peers = parseRequirementObject(manifest.peerDependencies, 'peerDependencies');
  for (const [name, value] of Object.entries(peers)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
    if (typeof value !== 'string') throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`);
    authoredKeys.push(name);
    const range = ['workspace:^', 'workspace:~', 'workspace:*'].includes(value) ? runtimeVersion : value;
    if (!authoredRange) authoredRange = value;
    if (range.trim() === '' || !semver.satisfies(runtimeVersion, range, { includePrerelease: true })) {
      requirements[name] = value;
    }
  }
  return { authoredRange, authoredKeys, requirements };
}

export function evaluateNodeRequirement(manifest: RawPackageManifest, nodeVersion: string): string | null {
  const engines = parseRequirementObject(manifest.engines, 'engines');
  const range = engines.node;
  if (range === undefined) return null;
  if (typeof range !== 'string') throw new Error('Plugin manifest engines.node must be a string');
  return semver.satisfies(nodeVersion, range, { includePrerelease: true }) ? null : range;
}

export function bundlePlatforms(manifest: RawPackageManifest): string[] | null {
  const bundle = manifest.dsh?.bundle;
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return null;
  const platforms = (bundle as Record<string, unknown>).platforms;
  if (platforms === undefined) return null;
  if (!Array.isArray(platforms) || platforms.length === 0 || !platforms.every((p) => typeof p === 'string')) {
    throw new Error('dsh.bundle.platforms must be a nonempty list of Node platform names');
  }
  return platforms as string[];
}

export function hasClientHalf(manifest: RawPackageManifest): boolean {
  return !!manifest.dsh && typeof manifest.dsh.client === 'object' && manifest.dsh.client !== null;
}

export function isNativeManifest(manifest: RawPackageManifest): boolean {
  const value = manifest.conecode;
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).plugin === true;
}

export function earlierThan(a: string, b: string): boolean {
  return semver.valid(a) !== null && semver.valid(b) !== null && semver.lt(a, b);
}

export interface CompatibilityInput {
  manifest: RawPackageManifest;
  baseline: DshBaseline;
  nodeVersion: string;
  platform: string;
  arch: string;
  missingHostServices: string[];
  verifications: Record<string, PluginVerification>;
  exemptions: string[];
  environment: DshRuntimeEnvironment;
}

/**
 * Compute a matrix cell without trusting the catalog: the package manifest
 * decides the author's range; a recorded run decides what we actually verified.
 */
export function computeCompatibility(input: CompatibilityInput): CompatibilityResult {
  const { manifest } = input;
  const reasons: CompatibilityReason[] = [];
  const missing: MissingCapability[] = [];
  const exemptions = new Set(input.exemptions);
  const key = `${manifest.name}@${manifest.version}`;
  const exempted = exemptions.has(input.baseline.version) || exemptions.has(`${key}@${input.baseline.version}`);

  let authored: DshRequirementResult;
  try {
    authored = evaluateDshRequirements(manifest, input.baseline.version);
  } catch (error) {
    return {
      state: 'incompatible',
      authoredRange: null,
      authoredKeys: [],
      requirements: {},
      reasons: [{ code: 'malformed-requirements', message: error instanceof Error ? error.message : String(error) }],
      missing,
      exempted: false,
    };
  }

  const requirements = { ...authored.requirements };
  if (Object.keys(requirements).length > 0 && exempted) {
    reasons.push({
      code: 'exemption-active',
      message: `The author range does not include DSH ${input.baseline.version}; the exact pair was explicitly exempted by the user.`,
    });
  }
  if (Object.keys(requirements).length > 0 && !exempted) {
    for (const [requirement, expected] of Object.entries(requirements)) {
      reasons.push({
        code: 'dsh-version',
        message: `Declared ${requirement} ${expected} does not include DSH ${input.baseline.version}.`,
        requirement,
        expected,
        actual: input.baseline.version,
      });
    }
    missing.push(`dsh-version:${input.baseline.version}` as MissingCapability);
  }

  let nodeRange: string | null = null;
  try {
    nodeRange = evaluateNodeRequirement(manifest, input.nodeVersion);
  } catch (error) {
    reasons.push({ code: 'malformed-node-requirement', message: error instanceof Error ? error.message : String(error) });
  }
  if (nodeRange && !exempted) {
    reasons.push({
      code: 'node-version',
      message: `Declared engines.node ${nodeRange} does not include Node ${input.nodeVersion}.`,
      requirement: 'engines.node',
      expected: nodeRange,
      actual: input.nodeVersion,
    });
    missing.push(`node-version:${input.nodeVersion}` as MissingCapability);
  }

  let platforms: string[] | null = null;
  try {
    platforms = bundlePlatforms(manifest);
  } catch (error) {
    reasons.push({ code: 'malformed-platforms', message: error instanceof Error ? error.message : String(error) });
  }
  if (platforms && !platforms.includes(input.platform) && !exempted) {
    reasons.push({
      code: 'platform',
      message: `Bundle declares platforms ${platforms.join(', ')}; this host is ${input.platform}.`,
      requirement: 'dsh.bundle.platforms',
      expected: platforms.join(', '),
      actual: input.platform,
    });
    missing.push(`platform:${input.platform}` as MissingCapability);
  }

  for (const service of input.missingHostServices) {
    reasons.push({
      code: 'missing-host-service',
      message: `Plugin injects "${service}", which ConeCode's DSH layer does not provide.`,
      requirement: service,
    });
    missing.push(`host-service:${service}` as MissingCapability);
  }

  if (hasClientHalf(manifest)) {
    reasons.push({
      code: 'web-client',
      message: 'This plugin includes a DSH Web interface that ConeCode cannot display.',
    });
    missing.push('web-client');
  }

  const verification = input.verifications[key];
  const verificationFresh = !!verification
    && verification.baseline === input.baseline.version
    && verification.baselineCommit === input.baseline.commit
    && verification.layerVersion === DSH_COMPAT_LAYER_VERSION
    && verification.environment.nodeVersion === input.environment.nodeVersion
    && verification.environment.platform === input.environment.platform
    && verification.environment.arch === input.environment.arch;

  if (missing.some((item) => item.startsWith('dsh-version:') || item.startsWith('node-version:') || item.startsWith('platform:'))) {
    return {
      state: 'incompatible',
      authoredRange: authored.authoredRange,
      authoredKeys: authored.authoredKeys,
      requirements,
      reasons,
      missing,
      verification: verificationFresh ? verification : undefined,
      exempted,
    };
  }

  if (verificationFresh && verification.state === 'incompatible') {
    return {
      state: 'incompatible',
      authoredRange: authored.authoredRange,
      authoredKeys: authored.authoredKeys,
      requirements,
      reasons: [
        ...reasons,
        { code: 'verification-incompatible', message: verification.notes || 'Recorded validation found this version incompatible.' },
      ],
      missing: [...new Set([...missing, ...verification.missingCapabilities])] as MissingCapability[],
      verification,
      exempted,
    };
  }

  if (missing.includes('web-client') || missing.some((item) => item.startsWith('host-service:'))
    || (exempted && Object.keys(requirements).length > 0)) {
    return {
      state: 'partial',
      authoredRange: authored.authoredRange,
      authoredKeys: authored.authoredKeys,
      requirements,
      reasons,
      missing: [...new Set([...missing, ...(verificationFresh ? verification.missingCapabilities : [])])] as MissingCapability[],
      verification: verificationFresh ? verification : undefined,
      exempted,
    };
  }

  if (verificationFresh) {
    return {
      state: verification.state,
      authoredRange: authored.authoredRange,
      authoredKeys: authored.authoredKeys,
      requirements,
      reasons: [
        ...reasons,
        ...verification.evidence.map((item) => ({ code: `verified:${item.kind}`, message: item.summary })),
      ],
      missing: [...new Set([...missing, ...verification.missingCapabilities])] as MissingCapability[],
      verification,
      exempted,
    };
  }

  return {
    state: 'unverified',
    authoredRange: authored.authoredRange,
    authoredKeys: authored.authoredKeys,
    requirements,
    reasons: [
      ...reasons,
      {
        code: 'no-verification',
        message: verification
          ? 'A verification record exists but is bound to a different baseline, layer version or runtime environment.'
          : 'No recorded execution exists for this exact plugin version on the current baseline.',
      },
    ],
    missing,
    verification: verificationFresh ? verification : undefined,
    exempted,
  };
}

export function rowsFromPatches(
  packageDir: string,
  packageName: string,
  patches: LoadedBundlePatch,
): InstalledRow[] {
  return patches.rows.map((row) => {
    const inject = Array.isArray(row.inject) ? row.inject.filter((x): x is string => typeof x === 'string') : [];
    return {
      id: row.id,
      name: row.name,
      entryPath: resolveRowModule(packageDir, packageName, row.name),
      config: row.config === undefined ? {} : row.config,
      disabled: row.disabled === true,
      inject,
    };
  });
}

export function moduleUrl(file: string): string {
  return pathToFileURL(file).href;
}

export function verificationKey(name: string, version: string): string {
  return `${name}@${version}`;
}
