import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  type MarketVersionSource,
  type InstalledRow,
} from '../../src/core/dsh-market/types';
import type { RawPackageManifest } from './manifest';
import {
  bundlePatchFiles,
  loadBundlePatches,
  readPackageManifest,
  resolvePackageEntry,
  rowsFromPatches,
} from './manifest';
import { assertInside, pluginDirectoryName, safeFileSegment, validateExactVersion, validatePackageName } from './security';
import { NPM_INSTALL_TIMEOUT_MS, SHARED_DSH_RUNTIME } from './constants';
import type { MarketStateStore } from './state';

export interface NativeManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  entry: string;
  apiVersion: number;
  capabilities: string[];
  config?: Record<string, unknown>;
  readme?: string;
}

export interface PreparedPackage {
  pluginId: string;
  profileId: string;
  directoryName: string;
  stagingDir: string;
  /** Absolute package directory inside staging (DSH: node_modules/<name>, native: staging root). */
  packageDir: string;
  /** Path relative to the final plugin directory. */
  packageRelativeDir: string;
  name: string;
  version: string;
  format: 'dsh' | 'native';
  manifest: RawPackageManifest;
  native?: NativeManifest;
  patchesWarnings: string[];
  rows: InstalledRow[];
  bundleOverrides: Array<Record<string, unknown>>;
  requestedSpec: string;
  resolvedSpec: string;
  integrity?: string;
  license?: string;
  clientUnsupported: boolean;
}

export interface PrepareOptions {
  profileId: string;
  requestId: string;
  name: string;
  version: string;
  source: MarketVersionSource;
  /** User explicitly allowed dependency lifecycle scripts. */
  allowScripts?: boolean;
  onLog: (line: string) => void;
  signal: AbortSignal;
}

export class NpmUnavailableError extends Error {
  constructor(message = 'npm was not found. Install Node.js 24.9+ with npm 10+, then retry.') {
    super(message);
    this.name = 'NpmUnavailableError';
  }
}

export class InstallCancelledError extends Error {
  constructor() {
    super('Installation cancelled');
    this.name = 'InstallCancelledError';
  }
}

/**
 * Where npm is allowed to cache downloads.
 *
 * npm otherwise uses the host cache (`~/.npm/_cacache`). On machines where that directory is
 * root-owned or read-only — a well known state after an earlier `sudo npm` — every install dies
 * with `npm error code EPERM` and the user only sees "Could not install the pinned DSH runtime".
 * Keeping the cache inside ConeCode's own data directory makes plugin installs independent of
 * the host cache's permissions. `CONECODE_NPM_CACHE` is an explicit escape hatch for operators.
 */
export function npmCacheDir(state: Pick<MarketStateStore, 'cacheDir'>): string {
  const override = process.env.CONECODE_NPM_CACHE?.trim();
  return override ? path.resolve(override) : path.join(state.cacheDir(), 'npm');
}

/** Environment for a child npm process; `npm_config_cache` points at our own cache when set. */
export function npmEnv(cacheDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_loglevel: 'error',
  };
  if (cacheDir) env.npm_config_cache = cacheDir;
  return env;
}

export class NpmRunner {
  private cachedPath: string | null = null;
  private cachedVersion: string | null = null;
  private children = new Set<ChildProcess>();

  constructor(private readonly cacheDir?: string) {}

  async locate(): Promise<{ path: string; version: string }> {
    if (this.cachedPath && this.cachedVersion) return { path: this.cachedPath, version: this.cachedVersion };
    const candidate = process.env.CONECODE_NPM || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const version = await new Promise<string>((resolve, reject) => {
      const child = spawn(candidate, ['--version'], { shell: false, env: process.env });
      let out = '';
      let err = '';
      child.stdout.on('data', (data) => { out += data.toString(); });
      child.stderr.on('data', (data) => { err += data.toString(); });
      child.on('error', () => reject(new NpmUnavailableError()));
      child.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new NpmUnavailableError(`npm exited with ${code}: ${err.trim()}`)));
    }).catch((error) => { throw error instanceof NpmUnavailableError ? error : new NpmUnavailableError(String(error)); });
    this.cachedPath = candidate;
    this.cachedVersion = version;
    return { path: candidate, version };
  }

  async run(args: string[], cwd: string, options: {
    timeoutMs?: number;
    onLog?: (line: string) => void;
    signal?: AbortSignal;
  } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const { path: npm } = await this.locate();
    if (options.signal?.aborted) throw new InstallCancelledError();
    // npm cannot create a cache it has no permission for; fall back to its default in that case
    // instead of failing the whole install on our own bookkeeping.
    let cacheDir = this.cacheDir;
    if (cacheDir) {
      try { fs.mkdirSync(cacheDir, { recursive: true }); }
      catch { cacheDir = undefined; }
    }
    const child = spawn(npm, args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: npmEnv(cacheDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.add(child);
    let stdout = '';
    let stderr = '';
    const emit = (chunk: string, stream: 'stdout' | 'stderr') => {
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) options.onLog?.(line);
    };
    child.stdout.on('data', (data) => emit(data.toString(), 'stdout'));
    child.stderr.on('data', (data) => emit(data.toString(), 'stderr'));
    const abort = () => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false });
        return;
      }
      if (!child.killed) child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 3000).unref();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    let timeout: NodeJS.Timeout | null = null;
    if (options.timeoutMs) {
      timeout = setTimeout(abort, options.timeoutMs);
    }
    try {
      const [code] = await once(child, 'close') as [number, NodeJS.Signals | null];
      if (options.signal?.aborted) throw new InstallCancelledError();
      if (timeout) clearTimeout(timeout);
      return { code, stdout, stderr };
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      this.children.delete(child);
    }
  }

  killAll(): void {
    for (const child of this.children) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }
}

function copyDirectory(source: string, destination: string): void {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (file) => {
      const base = path.basename(file);
      return base !== 'node_modules' && base !== '.git' && base !== 'dist' ? true : base === 'dist';
    },
  });
}

export function readNativeManifest(packageDir: string): NativeManifest | null {
  const manifestPath = path.join(packageDir, 'conecode.plugin.json');
  if (!fs.existsSync(manifestPath)) return null;
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const conecode = raw.conecode;
  if (!conecode || typeof conecode !== 'object' || Array.isArray(conecode) || (conecode as any).plugin !== true) {
    throw new Error('conecode.plugin.json must declare conecode.plugin = true');
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!name) throw new Error('conecode.plugin.json: name is required');
  validateExactVersion(version);
  const entry = (conecode as any).entry;
  if (typeof entry !== 'string' || !entry.trim()) throw new Error('conecode.plugin.json: conecode.entry is required');
  const apiVersion = (conecode as any).apiVersion;
  if (apiVersion !== 1) throw new Error(`conecode.plugin.json: unsupported apiVersion ${String(apiVersion)}`);
  const capabilities = Array.isArray((conecode as any).capabilities)
    ? (conecode as any).capabilities.filter((item: unknown): item is string => typeof item === 'string')
    : [];
  const entryPath = path.resolve(packageDir, entry);
  const relative = path.relative(fs.realpathSync(packageDir), entryPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('conecode.plugin.json: entry escapes the package directory');
  if (!fs.existsSync(entryPath)) throw new Error(`conecode.plugin.json: entry ${entry} is missing`);
  return {
    name,
    version,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    author: typeof raw.author === 'string' ? raw.author : undefined,
    license: typeof raw.license === 'string' ? raw.license : undefined,
    homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined,
    repository: typeof raw.repository === 'string' ? raw.repository : undefined,
    entry: relative,
    apiVersion,
    capabilities,
    config: (conecode as any).config && typeof (conecode as any).config === 'object' ? (conecode as any).config : undefined,
    readme: typeof raw.readme === 'string' ? raw.readme : undefined,
  };
}

export class PackageInstaller {
  private runner: NpmRunner;
  private currentProfile = 'default';

  constructor(private state: MarketStateStore) {
    this.runner = new NpmRunner(npmCacheDir(state));
  }

  async npmInfo(): Promise<{ path: string; version: string } | null> {
    try {
      return await this.runner.locate();
    } catch {
      return null;
    }
  }

  killAll(): void {
    this.runner.killAll();
  }

  async provisionRuntime(profileId: string, onLog: (line: string) => void, signal: AbortSignal): Promise<void> {
    this.state.ensureProfileDirs(profileId);
    const runtimeDir = this.state.runtimeDir(profileId);
    const marker = path.join(runtimeDir, 'runtime.json');
    let current = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as { packages?: Record<string, string>; node?: string };
      current = parsed.node === process.versions.node
        && SHARED_DSH_RUNTIME.every((pkg) => parsed.packages?.[pkg.name] === pkg.version)
        && SHARED_DSH_RUNTIME.every((pkg) => fs.existsSync(path.join(runtimeDir, 'node_modules', ...pkg.name.split('/'), 'package.json')));
    } catch {
      current = false;
    }
    if (!current) {
      onLog('Provisioning the pinned DSH compatibility runtime…');
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({
        name: 'conecode-dsh-compat-runtime',
        private: true,
        description: 'Pinned peer packages resolved by ConeCode DSH plugins. Managed automatically.',
        dependencies: Object.fromEntries(SHARED_DSH_RUNTIME.map((pkg) => [pkg.name, pkg.version])),
      }, null, 2), 'utf8');
      const result = await this.runner.run([
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--legacy-peer-deps',
      ], runtimeDir, { timeoutMs: NPM_INSTALL_TIMEOUT_MS, onLog, signal });
      if (result.code !== 0) {
        throw new Error(`Could not install the pinned DSH runtime (npm exit ${result.code}). ${result.stderr.slice(-800)}`);
      }
      fs.writeFileSync(marker, JSON.stringify({
        packages: Object.fromEntries(SHARED_DSH_RUNTIME.map((pkg) => [pkg.name, pkg.version])),
        node: process.versions.node,
        installedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
    }
    this.linkSharedRuntime(profileId);
  }

  private linkSharedRuntime(profileId: string): void {
    const profileDir = this.state.profileDir(profileId);
    const profileNodeModules = path.join(profileDir, 'node_modules');
    const runtimeModules = path.join(this.state.runtimeDir(profileId), 'node_modules');
    fs.mkdirSync(profileNodeModules, { recursive: true });
    const packages: string[] = [];
    const collect = (dir: string, prefix = '') => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name.startsWith('@')) {
          collect(full, `${entry.name}/`);
          continue;
        }
        if (entry.isDirectory() && fs.existsSync(path.join(full, 'package.json'))) packages.push(`${prefix}${entry.name}`);
      }
    };
    collect(runtimeModules);
    for (const name of packages) {
      const source = path.join(runtimeModules, ...name.split('/'));
      const destination = path.join(profileNodeModules, ...name.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      try {
        if (fs.existsSync(destination) || isSymlink(destination)) {
          // Never replace an installed plugin link with a shared-runtime link.
          const relative = path.relative(path.join(profileDir, 'plugins'), fs.realpathSync(destination));
          if (!relative.startsWith('..') && !path.isAbsolute(relative)) continue;
          if (fs.realpathSync(destination) === fs.realpathSync(source)) continue;
          fs.rmSync(destination, { recursive: true, force: true });
        }
        fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        // If symlinks are unavailable, copying still keeps resolution working.
        try { fs.cpSync(source, destination, { recursive: true, dereference: true }); } catch { /* report later */ }
      }
    }
  }

  async prepare(options: PrepareOptions): Promise<PreparedPackage> {
    const { profileId, requestId, name, version, source, onLog, signal } = options;
    validatePackageName(name);
    validateExactVersion(version);
    this.state.ensureProfileDirs(profileId);
    const nativeSource = source.type === 'bundled-example' ||
      (source.type === 'local' && !!source.path && fs.existsSync(source.path) &&
        fs.statSync(source.path).isDirectory() && !!readNativeManifest(source.path));
    if (!nativeSource) await this.provisionRuntime(profileId, onLog, signal);
    const directoryName = pluginDirectoryName(name);
    const stagingDir = assertInside(
      this.state.stagingDir(profileId),
      path.join(this.state.stagingDir(profileId), `${safeFileSegment(directoryName)}-${safeFileSegment(requestId)}`),
      'staging directory',
    );
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    try {
      const result = await this.prepareInto(options, stagingDir, directoryName);
      return result;
    } catch (error) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async prepareInto(options: PrepareOptions, stagingDir: string, directoryName: string): Promise<PreparedPackage> {
    const { profileId, name, version, source, onLog, signal } = options;
    let packageDir: string;
    let format: 'dsh' | 'native';
    let native: NativeManifest | null = null;
    let requestedSpec: string;

    if (source.type === 'bundled-example') {
      if (!source.path) throw new Error('Bundled example path is missing');
      const sourceDir = path.resolve(source.path);
      copyDirectory(sourceDir, stagingDir);
      native = readNativeManifest(stagingDir);
      if (!native) throw new Error('Bundled example is not a native plugin');
      if (native.name !== name || native.version !== version) {
        throw new Error(`Bundled example manifest is ${native.name}@${native.version}, expected ${name}@${version}`);
      }
      packageDir = stagingDir;
      format = 'native';
      requestedSpec = `example:${sourceDir}`;
      await this.installNativeDependencies(stagingDir, onLog, signal);
    } else if (source.type === 'local') {
      if (!source.path) throw new Error('Local plugin path is missing');
      const sourcePath = path.resolve(source.path);
      if (!fs.existsSync(sourcePath)) throw new Error(`Local plugin path does not exist: ${sourcePath}`);
      if (fs.statSync(sourcePath).isDirectory()) {
        const directNative = readNativeManifest(sourcePath);
        if (directNative) {
          copyDirectory(sourcePath, stagingDir);
          native = readNativeManifest(stagingDir);
          packageDir = stagingDir;
          format = 'native';
          requestedSpec = `file:${sourcePath}`;
          await this.installNativeDependencies(stagingDir, onLog, signal);
          if (!native || native.name !== name || native.version !== version) {
            throw new Error(`Local native manifest is ${native?.name || '?'}@${native?.version || '?'}, expected ${name}@${version}`);
          }
        } else {
          packageDir = path.join(stagingDir, 'node_modules', ...name.split('/'));
          fs.mkdirSync(path.dirname(packageDir), { recursive: true });
          copyDirectory(sourcePath, packageDir);
          const manifest = readPackageManifest(packageDir);
          if (manifest.name !== name || manifest.version !== version) {
            throw new Error(`Local package is ${manifest.name}@${manifest.version}, expected ${name}@${version}`);
          }
          const result = await this.runner.run([
            'install',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--legacy-peer-deps',
          ], packageDir, { timeoutMs: NPM_INSTALL_TIMEOUT_MS, onLog, signal });
          if (result.code !== 0) throw new Error(`Installing local plugin dependencies failed (npm exit ${result.code}). ${result.stderr.slice(-600)}`);
          format = 'dsh';
          requestedSpec = `file:${sourcePath}`;
        }
      } else {
        // Tarball / .tgz
        packageDir = path.join(stagingDir, 'node_modules', ...name.split('/'));
        this.writeInstallManifest(stagingDir, name, `file:${sourcePath}`);
        const result = await this.runner.run([
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--legacy-peer-deps',
        ], stagingDir, { timeoutMs: NPM_INSTALL_TIMEOUT_MS, onLog, signal });
        if (result.code !== 0) throw new Error(`Installing local tarball failed (npm exit ${result.code}). ${result.stderr.slice(-600)}`);
        format = 'dsh';
        requestedSpec = `file:${sourcePath}`;
      }
    } else {
      packageDir = path.join(stagingDir, 'node_modules', ...name.split('/'));
      const subdir = source.subdir?.replace(/\\/g, '/').replace(/^\.\//, '');
      if (subdir && (subdir.startsWith('/') || subdir.split('/').includes('..'))) throw new Error('Git package subdirectory must stay inside the repository.');
      const dependencySpec = source.type === 'git'
        ? `git+${source.url?.replace(/\.git$/, '')}.git#${source.commit}${subdir ? `&path:/${subdir}` : ''}`
        : version;
      const spec = source.type === 'git'
        ? dependencySpec
        : `${source.packageName || name}@${version}`;
      this.writeInstallManifest(stagingDir, source.packageName || name, dependencySpec, source.registry);
      const args = ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'];
      if (!options.allowScripts) args.push('--ignore-scripts');
      if (source.registry) args.push('--registry', source.registry);
      const result = await this.runner.run(args, stagingDir, { timeoutMs: NPM_INSTALL_TIMEOUT_MS, onLog, signal });
      if (result.code !== 0) throw new Error(`npm install failed (exit ${result.code}). ${result.stderr.slice(-1000)}`);
      format = 'dsh';
      requestedSpec = spec;
    }

    const manifest = format === 'dsh' ? readPackageManifest(packageDir) : nativeManifestToPackage(native!);
    if (manifest.name !== name || manifest.version !== version) {
      throw new Error(`Resolved package is ${manifest.name}@${manifest.version}, expected ${name}@${version}`);
    }
    this.assertDependencies(stagingDir, packageDir, manifest);
    let rows: InstalledRow[] = [];
    let patchesWarnings: string[] = [];
    let bundleOverrides: Array<Record<string, unknown>> = [];
    if (format === 'dsh') {
      const patches = loadBundlePatches(packageDir, manifest);
      patchesWarnings = patches.warnings;
      bundleOverrides = patches.patches.filter((patch) => !Array.isArray(patch.insert));
      rows = rowsFromPatches(packageDir, manifest.name!, patches);
      if (platformSupported(manifest) === false) {
        throw new Error(`Bundle declares platforms ${JSON.stringify((manifest.dsh?.bundle as any)?.platforms)}; this host is ${process.platform}`);
      }
    } else {
      const entry = resolveNativeEntry(packageDir, native!);
      rows = [{
        id: 'native',
        name: native!.name,
        entryPath: entry,
        config: {},
        disabled: false,
        inject: [],
      }];
    }

    const integrity = await this.integrityOf(stagingDir, packageDir, format, name);
    const clientUnsupported = format === 'dsh' && !!manifest.dsh?.client;
    return {
      pluginId: name,
      profileId,
      directoryName,
      stagingDir,
      packageDir,
      packageRelativeDir: path.relative(stagingDir, packageDir) || '.',
      name,
      version,
      format,
      manifest,
      ...(native ? { native } : {}),
      patchesWarnings,
      rows,
      bundleOverrides,
      requestedSpec,
      resolvedSpec: `${name}@${version}`,
      ...(integrity ? { integrity } : {}),
      ...(typeof manifest.license === 'string' ? { license: manifest.license } : {}),
      clientUnsupported,
    };
  }

  private async installNativeDependencies(stagingDir: string, onLog: (line: string) => void, signal: AbortSignal): Promise<void> {
    const packageFile = path.join(stagingDir, 'package.json');
    if (!fs.existsSync(packageFile)) return;
    let manifest: { dependencies?: Record<string, unknown> };
    try {
      manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { dependencies?: Record<string, unknown> };
    } catch (error) {
      throw new Error(`Native plugin package.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!manifest.dependencies || Object.keys(manifest.dependencies).length === 0) return;
    const result = await this.runner.run([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--legacy-peer-deps',
    ], stagingDir, { timeoutMs: NPM_INSTALL_TIMEOUT_MS, onLog, signal });
    if (result.code !== 0) throw new Error(`Installing native plugin dependencies failed (npm exit ${result.code}). ${result.stderr.slice(-600)}`);
  }

  private assertDependencies(stagingDir: string, packageDir: string, manifest: RawPackageManifest): void {
    const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
    const missing: string[] = [];
    for (const name of Object.keys(dependencies)) {
      const local = path.join(packageDir, 'node_modules', ...name.split('/'));
      const hoisted = path.join(stagingDir, 'node_modules', ...name.split('/'));
      const shared = path.join(this.state.profileDir(this.currentProfile), 'node_modules', ...name.split('/'));
      try {
        if (fs.existsSync(path.join(local, 'package.json')) || fs.existsSync(path.join(hoisted, 'package.json')) || fs.existsSync(path.join(shared, 'package.json'))) continue;
      } catch {
        // fall through
      }
      // A dangling symlink is a broken install even if existsSync is false.
      missing.push(name);
    }
    if (missing.length) throw new Error(`Resolved dependencies are missing: ${missing.join(', ')}`);
  }

  private writeInstallManifest(stagingDir: string, name: string, spec: string, registry?: string): void {
    fs.writeFileSync(path.join(stagingDir, 'package.json'), JSON.stringify({
      name: 'conecode-dsh-plugin-install',
      private: true,
      description: 'Temporary install root managed by ConeCode. Safe to delete.',
      dependencies: { [name]: spec },
      ...(registry ? { publishConfig: { registry } } : {}),
    }, null, 2), 'utf8');
  }

  private async integrityOf(stagingDir: string, packageDir: string, format: 'dsh' | 'native', name: string): Promise<string | undefined> {
    if (format === 'dsh') {
      try {
        const lock = JSON.parse(fs.readFileSync(path.join(stagingDir, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { integrity?: string }> };
        const entry = lock.packages?.[`node_modules/${name}`];
        if (entry?.integrity) return entry.integrity;
      } catch {
        // fall through to a local hash
      }
    }
    const hash = crypto.createHash('sha256');
    const files = [
      path.join(packageDir, 'package.json'),
      path.join(packageDir, 'conecode.plugin.json'),
      ...(format === 'native' ? [path.join(packageDir, readNativeManifest(packageDir)?.entry || 'index.mjs')] : []),
    ];
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      hash.update(path.basename(file));
      hash.update(fs.readFileSync(file));
    }
    return `sha256-${hash.digest('base64')}`;
  }

  finalDirectory(profileId: string, directoryName: string): string {
    return this.state.pluginRoot(profileId, directoryName);
  }

  /** Move a prepared staging tree into its final plugin directory. */
  swapIn(prepared: PreparedPackage): { finalDir: string; backupDir: string | null } {
    const finalDir = this.finalDirectory(prepared.profileId, prepared.directoryName);
    let backupDir: string | null = null;
    if (fs.existsSync(finalDir)) {
      const backupRoot = path.join(this.state.backupsDir(prepared.profileId), prepared.directoryName);
      fs.mkdirSync(backupRoot, { recursive: true });
      backupDir = path.join(backupRoot, `${prepared.version}-${Date.now()}`);
      fs.renameSync(finalDir, backupDir);
    }
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    fs.renameSync(prepared.stagingDir, finalDir);
    return { finalDir, backupDir };
  }

  restore(finalDir: string, backupDir: string): void {
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(backupDir, finalDir);
  }

  removeBackup(backupDir: string | null): void {
    if (backupDir) fs.rmSync(backupDir, { recursive: true, force: true });
  }

  linkPlugin(profileId: string, name: string, finalDir: string, packageRelativeDir: string): void {
    if (packageRelativeDir === '.') {
      // Native plugin: no package name entry is required for Node resolution.
      return;
    }
    const profileModules = path.join(this.state.profileDir(profileId), 'node_modules');
    const destination = path.join(profileModules, ...name.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination) || isSymlink(destination)) fs.rmSync(destination, { recursive: true, force: true });
    const target = path.join(finalDir, packageRelativeDir);
    fs.symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
  }

  unlinkPlugin(profileId: string, name: string): void {
    const destination = path.join(this.state.profileDir(profileId), 'node_modules', ...name.split('/'));
    try {
      if (fs.existsSync(destination) || isSymlink(destination)) fs.rmSync(destination, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function isSymlink(file: string): boolean {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

function platformSupported(manifest: RawPackageManifest): boolean {
  const bundle = manifest.dsh?.bundle;
  if (!bundle || typeof bundle !== 'object') return true;
  const platforms = (bundle as Record<string, unknown>).platforms;
  if (platforms === undefined) return true;
  return Array.isArray(platforms) && platforms.includes(process.platform);
}

function resolveNativeEntry(packageDir: string, native: NativeManifest): string {
  const resolved = path.resolve(packageDir, native.entry);
  const relative = path.relative(fs.realpathSync(packageDir), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Native entry escapes the package');
  if (!fs.existsSync(resolved)) throw new Error('Native entry is missing');
  return fs.realpathSync(resolved);
}

function nativeManifestToPackage(native: NativeManifest): RawPackageManifest {
  return {
    name: native.name,
    version: native.version,
    description: native.description,
    author: native.author,
    license: native.license,
    homepage: native.homepage,
    repository: native.repository,
    conecode: { plugin: true, apiVersion: native.apiVersion, entry: native.entry, capabilities: native.capabilities },
  };
}

export function packageEntryPath(prepared: PreparedPackage): string {
  if (prepared.format === 'native') return resolveNativeEntry(prepared.packageDir, prepared.native!);
  return resolvePackageEntry(prepared.packageDir, '.');
}

export { bundlePatchFiles };
