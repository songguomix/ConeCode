import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';
import type {
  BackupRecord,
  CatalogPage,
  CatalogQuery,
  CompatibilityResult,
  DshRuntimeEnvironment,
  InstallOperation,
  InstalledPlugin,
  InstalledRow,
  InvokeResult,
  LogsResult,
  MarketCatalog,
  MarketCategory,
  MarketEvent,
  MarketPlugin,
  MarketProfile,
  MarketSnapshot,
  MarketSource,
  MarketVersion,
  PluginContributions,
  PluginDetail,
  PluginVerification,
  RepositoryInspection,
  RuntimeInfo,
  SkillContribution,
} from '../../src/core/dsh-market/types';
import { DSH_BASELINE, DSH_COMPAT_LAYER_VERSION } from '../../src/core/dsh-market/types';
import { chatServerName, isDshChatServer } from '../../src/core/dsh-market/naming';
import { MarketStateStore } from './state';
import { DshRuntimeManager } from './runtime-manager';
import { OfficialDshWeb } from './official-web';
import type { RuntimePluginSpec, RuntimePluginState } from './runtime-host';
import { PackageInstaller, npmCacheDir, InstallCancelledError, nativeManifestToPackage, readNativeManifest, type PreparedPackage } from './installer';
import {
  computeCompatibility,
  bundleOverrides,
  loadBundlePatches,
  manifestAuthor,
  manifestRepository,
  readPackageManifest,
  rowsFromPatches,
  type RawPackageManifest,
} from './manifest';
import {
  MARKET_CATEGORIES,
  latestVersion,
  mergeCatalogs,
  parseCatalogDocument,
  queryCatalog,
} from './catalog';
import { loadVerificationRecords } from './verifications';
import { inspectRemoteRepository } from './repository';
import { currentEnvironment } from './verifications';
import {
  assertInside,
  buildInstallSpec,
  normalizeUserInputUrl,
  packageReadme,
  pluginDirectoryName,
  safeFileSegment,
  validateGitUrl,
  validateProfileId,
} from './security';
import { MAX_CATALOG_BYTES, MAX_README_BYTES } from './constants';

const BUNDLED_SOURCE_ID = 'bundled';
const NATIVE_EXAMPLE_NAME = 'hello-conecode';

interface ServiceOptions {
  rootDir: string;
  appPath: string;
  versions: { app: string; electron: string; chrome?: string };
  emit?: (event: MarketEvent) => void;
}

interface ActiveOperation {
  requestId: string;
  controller: AbortController;
  kind: InstallOperation['kind'];
}

function isoNow(): string {
  return new Date().toISOString();
}

function makeRequestId(): string {
  return crypto.randomUUID();
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function existsFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function relocated(file: string, from: string, to: string): string {
  const relative = path.relative(from, file);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? file : path.join(to, relative);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export class DshMarketService {
  readonly state: MarketStateStore;
  readonly installer: PackageInstaller;
  readonly runtime: DshRuntimeManager;
  readonly web: OfficialDshWeb;
  readonly environment: DshRuntimeEnvironment;
  private verifications: Record<string, PluginVerification>;
  private catalogs = new Map<string, MarketCatalog>();
  private activeOperations = new Map<string, ActiveOperation>();
  private uninstalledPackages = new Set<string>();
  private runtimeMutations = Promise.resolve();
  private emitSink: ((event: MarketEvent) => void) | undefined;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private npm: { path: string; version: string } | null = null;
  private warnings: string[] = [];

  constructor(private options: ServiceOptions) {
    this.state = new MarketStateStore(options.rootDir);
    this.installer = new PackageInstaller(this.state);
    this.runtime = new DshRuntimeManager();
    this.web = new OfficialDshWeb(npmCacheDir(this.state));
    this.environment = currentEnvironment({
      app: options.versions.app,
      electron: options.versions.electron,
      chrome: options.versions.chrome,
    });
    this.verifications = loadVerificationRecords(options.appPath);
    this.emitSink = options.emit;
    this.runtime.onEvent((event) => this.emit(event));
  }

  private emit(event: MarketEvent): void {
    this.emitSink?.(event);
  }

  private get dshHome(): string {
    return this.options.rootDir;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.doInitialize().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  private async doInitialize(): Promise<void> {
    this.state.cleanupStaging();
    this.ensureBundledSource();
    const active = this.state.activeProfile();
    this.state.ensureProfileDirs(active.id);
    this.npm = await this.installer.npmInfo();
    this.loadCachedCatalogs();
    this.writeProjection(active.id);
    await this.loadAllEnabled(active.id).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.warnings.push(`Runtime initialization failed: ${message}`);
      this.emit({ type: 'runtime', message, level: 'error' });
    });
    this.initialized = true;
  }

  async ensureReady(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private requireActiveProfile(profileId: string): void {
    if (profileId !== this.state.activeProfileId()) {
      throw new Error(`Profile ${profileId} is no longer active. Switch to it before using its plugins.`);
    }
  }

  private ensureBundledSource(): void {
    const sources = this.state.sources();
    if (sources.some((source) => source.id === BUNDLED_SOURCE_ID)) return;
    const location = this.bundledCatalogPath() || 'resources/dsh-market/catalog.json';
    this.state.upsertSource({
      id: BUNDLED_SOURCE_ID,
      title: 'ConeCode DSH 精选目录',
      kind: 'bundled',
      location,
      enabled: true,
      lastSyncAt: null,
      lastError: null,
      cachedEntries: 0,
      stale: false,
    });
  }

  private bundledCatalogPath(): string | null {
    const candidates = [
      path.join(this.options.appPath, 'resources', 'dsh-market', 'catalog.json'),
      path.join(process.resourcesPath || '', 'dsh-market', 'catalog.json'),
      path.join(process.cwd(), 'resources', 'dsh-market', 'catalog.json'),
    ];
    return candidates.find(existsFile) || null;
  }

  private nativeExampleDir(): string | null {
    const candidates = [
      path.join(this.options.appPath, 'examples', 'native-plugins', NATIVE_EXAMPLE_NAME),
      path.join(process.resourcesPath || '', 'examples', 'native-plugins', NATIVE_EXAMPLE_NAME),
      path.join(process.cwd(), 'examples', 'native-plugins', NATIVE_EXAMPLE_NAME),
      path.join(path.dirname(this.options.appPath), 'examples', 'native-plugins', NATIVE_EXAMPLE_NAME),
    ];
    return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'conecode.plugin.json'))) || null;
  }

  private nativeExampleEntry(): MarketPlugin | null {
    const dir = this.nativeExampleDir();
    if (!dir) return null;
    try {
      const native = readNativeManifest(dir);
      if (!native) return null;
      const readme = packageReadme(dir, native.readme)?.text;
      return {
        id: native.name,
        name: native.name,
        format: 'native',
        title: 'Hello ConeCode（原生插件示例）',
        description: native.description || 'Minimum ConeCode-native plugin with a tool, command and skill.',
        author: native.author,
        homepage: native.homepage,
        repository: native.repository ? { url: native.repository } : undefined,
        license: native.license,
        category: 'native',
        labels: ['sample', 'native'],
        keywords: ['conecode', 'native', 'example'],
        declared: {},
        versions: [{
          version: native.version,
          publishedAt: new Date(0).toISOString(),
          source: { type: 'bundled-example', path: dir },
          engines: {},
          peerDependencies: {},
          dependencies: {},
        }],
        demo: true,
        sourceId: BUNDLED_SOURCE_ID,
        readme,
      };
    } catch {
      return null;
    }
  }

  private loadCachedCatalogs(): void {
    const sources = this.state.sources();
    const updated: MarketSource[] = [];
    for (const source of sources) {
      if (!source.enabled) {
        updated.push(source);
        continue;
      }
      try {
        const catalog = this.loadSourceCatalogSync(source);
        this.catalogs.set(source.id, catalog);
        let lastSyncAt = source.lastSyncAt;
        if (source.kind === 'bundled') lastSyncAt = catalog.generatedAt || source.lastSyncAt;
        else {
          try {
            const cache = readJson<{ fetchedAt?: string }>(this.sourceCachePath(source));
            lastSyncAt = source.lastSyncAt || cache.fetchedAt || null;
          } catch {
            // keep the recorded sync time
          }
        }
        const status = source.kind === 'bundled' ? { lastError: null, stale: false } : {};
        updated.push({ ...source, ...status, lastSyncAt, cachedEntries: catalog.plugins.length });
      } catch (error) {
        updated.push(source);
        this.warnings.push(`${source.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.state.setSources(updated);
    const activeSourceIds = new Set(sources.filter((source) => source.enabled).map((source) => source.id));
    const count = mergeCatalogs([...this.catalogs.values()], activeSourceIds).length;
    if (!count) this.warnings.push('The bundled DSH catalog is missing or empty. Check resources/dsh-market/catalog.json.');
  }

  private loadSourceCatalogSync(source: MarketSource): MarketCatalog {
    if (source.kind === 'bundled') {
      const file = this.bundledCatalogPath();
      if (!file) throw new Error('Bundled catalog file is missing');
      const catalog = parseCatalogDocument(readJson(file), source.id);
      const native = this.nativeExampleEntry();
      if (native) catalog.plugins.push(native);
      return catalog;
    }
    const cache = this.sourceCachePath(source);
    if (!existsFile(cache)) throw new Error(source.lastError || 'No cached catalog yet');
    const parsed = readJson<{ fetchedAt?: string; document?: unknown }>(cache);
    if (!parsed.document) throw new Error('Catalog cache is empty');
    return this.parseSourceDocument(source, parsed.document);
  }

  private parseSourceDocument(source: MarketSource, document: unknown): MarketCatalog {
    const catalog = parseCatalogDocument(document, source.id);
    for (const plugin of catalog.plugins) {
      for (const version of plugin.versions) {
        if (version.source.type !== 'local' && version.source.type !== 'bundled-example') continue;
        if (source.kind === 'remote') {
          throw new Error(`Remote catalog ${source.id} references a local path for ${plugin.name}@${version.version}; import local plugins explicitly.`);
        }
        if (source.kind === 'local' && version.source.path) {
          const base = existsFile(source.location) ? path.dirname(source.location) : source.location;
          version.source.path = path.resolve(base, version.source.path);
        }
      }
    }
    return catalog;
  }

  private sourceCachePath(source: MarketSource): string {
    return path.join(this.state.cacheDir(), 'sources', `${safeFileSegment(source.id)}.json`);
  }

  private readmeCachePath(name: string, version: string): string {
    return path.join(this.state.cacheDir(), 'readme', `${safeFileSegment(name)}-${safeFileSegment(version)}.json`);
  }

  private async fetchText(url: string, maxBytes: number, timeoutMs = 20_000, followRedirects = false): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        redirect: followRedirects ? 'follow' : 'manual',
        headers: { accept: 'text/plain,text/markdown,application/json;q=0.8', 'user-agent': 'ConeCode-DSH-Market/1.0' },
        signal: controller.signal,
      });
      if (!followRedirects && response.status >= 300 && response.status < 400) {
        throw new Error(`Catalog redirects are refused (HTTP ${response.status}); configure the final URL.`);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      if (!response.body) return '';
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new Error(`Response exceeds the ${humanSize(maxBytes)} limit`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks, bytes).toString('utf8');
    } finally {
      clearTimeout(timer);
    }
  }

  private async syncSource(source: MarketSource, force: boolean): Promise<MarketSource> {
    if (source.kind === 'bundled') {
      const catalog = this.loadSourceCatalogSync(source);
      this.catalogs.set(source.id, catalog);
      return {
        ...source,
        lastSyncAt: catalog.generatedAt || isoNow(),
        lastError: null,
        cachedEntries: catalog.plugins.length,
        stale: false,
      };
    }
    const cacheFile = this.sourceCachePath(source);
    if (!force && this.catalogs.has(source.id) && source.lastSyncAt) {
      return { ...source, cachedEntries: this.catalogs.get(source.id)!.plugins.length };
    }
    try {
      let document: unknown;
      if (source.kind === 'remote') {
        const url = normalizeUserInputUrl(source.location);
        const text = await this.fetchText(url, MAX_CATALOG_BYTES, 30_000);
        try { document = JSON.parse(text); } catch { throw new Error('Catalog response is not valid JSON'); }
      } else {
        const location = path.resolve(source.location);
        const file = fs.statSync(location).isDirectory() ? path.join(location, 'catalog.json') : location;
        if (!existsFile(file)) throw new Error(`Catalog file not found: ${file}`);
        const stat = fs.statSync(file);
        if (stat.size > MAX_CATALOG_BYTES) throw new Error(`Catalog is too large (${humanSize(stat.size)})`);
        try { document = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Catalog file is not valid JSON'); }
      }
      const catalog = this.parseSourceDocument(source, document);
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const fetchedAt = isoNow();
      const tempFile = `${cacheFile}.${makeRequestId()}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify({
        fetchedAt,
        document,
        title: catalog.title,
      }, null, 2), 'utf8');
      fs.renameSync(tempFile, cacheFile);
      this.catalogs.set(source.id, catalog);
      return {
        ...source,
        lastSyncAt: fetchedAt,
        lastError: null,
        cachedEntries: catalog.plugins.length,
        cachePath: cacheFile,
        stale: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let stale = false;
      let count = 0;
      if (existsFile(cacheFile)) {
        try {
          const cached = this.loadSourceCatalogSync({ ...source, lastError: message });
          this.catalogs.set(source.id, cached);
          count = cached.plugins.length;
          stale = true;
        } catch {
          // no usable cache
        }
      }
      return {
        ...source,
        lastError: message,
        cachedEntries: count,
        cachePath: cacheFile,
        stale,
      };
    }
  }

  async refreshSources(sourceId?: string): Promise<MarketSource[]> {
    await this.ensureReady();
    const sources = this.state.sources();
    for (const source of sources) {
      if ((sourceId && source.id !== sourceId) || !source.enabled) continue;
      const next = await this.syncSource(source, true);
      if (this.state.sources().some((item) => item.id === source.id)) this.state.upsertSource(next);
      else this.catalogs.delete(source.id);
    }
    this.emit({ type: 'sources', message: sourceId ? `Synced ${sourceId}` : 'Synced all catalog sources' });
    return this.state.sources();
  }

  async addRemoteSource(url: string, title?: string): Promise<MarketSource> {
    await this.ensureReady();
    const normalized = normalizeUserInputUrl(url);
    const id = `remote-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 10)}`;
    const existing = this.state.sources().find((source) => source.id === id);
    if (existing) throw new Error('This catalog URL is already configured.');
    const source: MarketSource = {
      id,
      title: title?.trim() || new URL(normalized).hostname,
      kind: 'remote',
      location: normalized,
      enabled: true,
      lastSyncAt: null,
      lastError: null,
      cachedEntries: 0,
      stale: false,
    };
    const synced = await this.syncSource(source, true);
    this.state.upsertSource(synced);
    this.emit({ type: 'sources', message: `Added ${synced.title}` });
    return synced;
  }

  async addLocalSource(directory: string): Promise<MarketSource> {
    await this.ensureReady();
    const resolved = path.resolve(directory);
    if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${resolved}`);
    const catalogFile = fs.statSync(resolved).isDirectory() ? path.join(resolved, 'catalog.json') : resolved;
    if (!existsFile(catalogFile)) throw new Error(`No catalog.json in ${resolved}`);
    const id = `local-${crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 10)}`;
    if (this.state.sources().some((source) => source.id === id)) throw new Error('This local catalog is already configured.');
    const source: MarketSource = {
      id,
      title: path.basename(path.dirname(catalogFile)) || 'Local catalog',
      kind: 'local',
      location: resolved,
      enabled: true,
      lastSyncAt: null,
      lastError: null,
      cachedEntries: 0,
      stale: false,
    };
    const synced = await this.syncSource(source, true);
    this.state.upsertSource(synced);
    this.emit({ type: 'sources', message: `Added ${synced.title}` });
    return synced;
  }

  removeSource(id: string): void {
    if (id === BUNDLED_SOURCE_ID) throw new Error('The bundled catalog cannot be removed.');
    this.state.removeSource(id);
    this.catalogs.delete(id);
    this.emit({ type: 'sources', message: `Removed source ${id}` });
  }

  private allPlugins(): MarketPlugin[] {
    const activeSourceIds = new Set(this.state.sources().filter((source) => source.enabled).map((source) => source.id));
    const plugins = mergeCatalogs([...this.catalogs.values()], activeSourceIds);
    if (!plugins.some((plugin) => plugin.name === NATIVE_EXAMPLE_NAME)) {
      const native = this.nativeExampleEntry();
      if (native) plugins.push(native);
    }
    return plugins;
  }

  private findPlugin(pluginId: string): MarketPlugin | null {
    return this.allPlugins().find((plugin) => plugin.id === pluginId || plugin.name === pluginId) || null;
  }

  private findVersion(plugin: MarketPlugin, version?: string): MarketVersion {
    if (!version) return latestVersion(plugin);
    const found = plugin.versions.find((item) => item.version === version);
    if (!found) throw new Error(`${plugin.name}@${version} is not listed in the configured catalogs.`);
    return found;
  }

  private syntheticManifest(plugin: MarketPlugin, version: MarketVersion): RawPackageManifest {
    return {
      name: plugin.name,
      version: version.version,
      description: plugin.description,
      license: plugin.license,
      author: plugin.author,
      homepage: plugin.homepage,
      repository: plugin.repository,
      engines: {
        ...(version.engines.dsh ? { dsh: version.engines.dsh } : {}),
        ...(version.engines.node ? { node: version.engines.node } : {}),
      },
      peerDependencies: version.peerDependencies,
      dependencies: version.dependencies,
      dsh: plugin.dsh as RawPackageManifest['dsh'],
    };
  }

  private compatibilityFor(plugin: MarketPlugin, version: MarketVersion, profileId: string, installed?: InstalledPlugin | null, manifest?: RawPackageManifest): CompatibilityResult {
    if (plugin.format === 'native') {
      const sample = plugin.demo === true && plugin.name === NATIVE_EXAMPLE_NAME && version.source.type === 'bundled-example';
      return {
        state: sample ? 'verified' : 'unverified',
        authoredRange: null,
        authoredKeys: [],
        requirements: {},
        reasons: [sample
          ? { code: 'native-sample', message: 'Bundled native sample verified by the lifecycle test.' }
          : { code: 'native-plugin', message: 'ConeCode native API v1 plugin with no recorded compatibility test.' }],
        missing: [],
        exempted: false,
      };
    }
    const key = `${plugin.name}@${version.version}`;
    const exemptions = this.state.exemptionVersions(profileId, key);
    const missingHostServices = (installed?.version === version.version ? installed.compatibility?.missing : undefined)
      ?.filter((item) => item.startsWith('host-service:'))
      .map((item) => item.slice('host-service:'.length)) || [];
    return computeCompatibility({
      manifest: manifest || this.syntheticManifest(plugin, version),
      baseline: DSH_BASELINE,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      missingHostServices,
      verifications: this.verifications,
      exemptions,
      environment: this.environment,
    });
  }

  private compatibilityWithProbe(plugin: MarketPlugin, version: MarketVersion, profileId: string, probe: RuntimePluginState, manifest?: RawPackageManifest): CompatibilityResult {
    const base = this.compatibilityFor(plugin, version, profileId, null, manifest);
    const missing = probe.missing || [];
    if (!missing.length) return base;
    return {
      ...base,
      state: 'partial',
      missing: [...new Set([...base.missing, ...missing.map((item) => `host-service:${item}` as const)])],
      reasons: [
        ...base.reasons,
        ...missing.map((item) => ({
          code: 'missing-host-service',
          message: `Plugin injects "${item}", which this layer does not provide.`,
          requirement: item,
        })),
      ],
    };
  }

  private profiles(): MarketProfile[] {
    const activeId = this.state.activeProfileId();
    return this.state.profiles().map((profile) => {
      const installed = profile.pluginOrder.map((id) => profile.plugins[id]).filter(Boolean);
      return {
        id: profile.id,
        name: profile.name,
        createdAt: profile.createdAt,
        active: profile.id === activeId,
        pluginCount: installed.length,
        enabledCount: installed.filter((plugin) => plugin.enabled).length,
        directory: this.state.profileDir(profile.id),
      };
    });
  }

  async snapshot(query: CatalogQuery = {}): Promise<MarketSnapshot> {
    await this.ensureReady();
    const profileId = this.state.activeProfileId();
    const plugins = this.allPlugins();
    const installed = this.state.installed(profileId);
    const installedByName = new Map(installed.map((plugin) => [plugin.name, plugin]));
    const page = queryCatalog(
      plugins,
      query,
      (plugin) => {
        const installedPlugin = installedByName.get(plugin.name);
        if (installedPlugin && installedPlugin.version === plugin.versions[0]?.version) return installedPlugin.compatibility;
        return this.compatibilityFor(plugin, plugin.versions[0], profileId, installedPlugin);
      },
      (plugin) => installedByName.get(plugin.name) || null,
    );
    const sources = this.state.sources().map((source) => ({
      ...source,
      cachedEntries: this.catalogs.get(source.id)?.plugins.length ?? source.cachedEntries,
    }));
    const npm = this.npm;
    const runtime = this.runtime.getInfo();
    const runtimeInfo: RuntimeInfo = {
      available: runtime.available,
      profileId: runtime.profileId,
      workerPid: runtime.threadId,
      startedAt: runtime.startedAt,
      lastError: runtime.lastError,
      baseline: DSH_BASELINE,
      layerVersion: DSH_COMPAT_LAYER_VERSION,
      environment: this.environment,
      supportedServices: [
        'tools', 'commands', 'skills', 'credentials',
        'systemPrompt', 'sessions', 'shellEnv', 'webServer',
        'fs', 'userApproval', 'scope', 'memory', 'connection', 'agents',
        ...(runtime.llmReady ? ['llm'] : []),
        ...(runtime.storage?.ready ? ['storage', 'storageDomain', 'storage.backend.json'] : []),
      ],
      supportedFormats: ['dsh-bundle (host + client bridge)', 'conecode-native'],
      npmPath: npm?.path || null,
      npmVersion: npm?.version || null,
      storage: runtime.storage || { ready: false, backend: null, root: null, error: 'Storage stack unavailable' },
    };
    return {
      profile: this.profiles().find((profile) => profile.id === profileId)!,
      profiles: this.profiles(),
      catalog: page,
      installed,
      sources,
      operations: this.state.operations(profileId),
      runtime: runtimeInfo,
      baseline: DSH_BASELINE,
      layerVersion: DSH_COMPAT_LAYER_VERSION,
      offline: sources.some((source) => !!source.lastError) || !runtime.available,
      warnings: [...this.warnings, ...this.runtimeWarnings()],
    };
  }

  private runtimeWarnings(): string[] {
    const warnings: string[] = [];
    for (const plugin of this.state.installed()) {
      if (plugin.enabled && plugin.status === 'load-failed') warnings.push(`${plugin.name}: ${plugin.lastError || 'load failed'}`);
      if (plugin.enabled && plugin.status === 'restart-required') warnings.push(`${plugin.name} needs a runtime restart.`);
    }
    return warnings;
  }

  async versions(pluginId: string): Promise<{ latest: string | null; versions: string[] }> {
    await this.ensureReady();
    const plugin = this.findPlugin(pluginId);
    if (!plugin) return { latest: null, versions: [] };
    return { latest: plugin.versions[0]?.version || null, versions: plugin.versions.map((item) => item.version) };
  }

  private installedMarketPlugin(installed: InstalledPlugin): MarketPlugin {
    const raw = installed.manifestRaw as RawPackageManifest;
    const readme = packageReadme(installed.packageDir)?.text;
    const source = installed.source || (installed.requestedSpec.startsWith('git+')
      ? { type: 'git' as const, url: installed.requestedSpec.replace(/^git\+/, '').split('#')[0].replace(/\.git$/, ''), commit: installed.requestedSpec.split('#')[1]?.split('&')[0] || '' }
      : installed.requestedSpec.startsWith('file:')
        ? { type: 'local' as const, path: installed.requestedSpec.slice('file:'.length) }
        : { type: 'npm' as const });
    return {
      id: installed.id,
      name: installed.name,
      format: installed.format,
      title: installed.title,
      description: typeof raw.description === 'string' ? raw.description : '',
      author: manifestAuthor(raw),
      homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined,
      repository: manifestRepository(raw),
      license: typeof raw.license === 'string' ? raw.license : installed.license,
      category: installed.format === 'native' ? 'native' : raw.dsh?.client ? 'interface' : 'tools',
      labels: ['installed'],
      keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((item): item is string => typeof item === 'string') : [],
      dsh: installed.dsh,
      declared: {
        engines: Object.fromEntries(Object.entries(raw.engines || {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
        peerDependencies: Object.fromEntries(Object.entries(raw.peerDependencies || {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
        dsh: installed.dsh,
      },
      versions: [{
        version: installed.version,
        publishedAt: installed.updatedAt,
        source,
        engines: {
          ...(typeof raw.engines?.dsh === 'string' ? { dsh: raw.engines.dsh } : {}),
          ...(typeof raw.engines?.node === 'string' ? { node: raw.engines.node } : {}),
        },
        peerDependencies: Object.fromEntries(Object.entries(raw.peerDependencies || {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
        dependencies: Object.fromEntries(Object.entries(raw.dependencies || {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
        ...(typeof raw.license === 'string' ? { license: raw.license } : {}),
      }],
      sourceId: 'installed',
      ...(readme ? { readme } : {}),
    };
  }

  async detail(pluginId: string, version?: string): Promise<PluginDetail> {
    await this.ensureReady();
    const installed = this.state.installedByMarketId(this.state.activeProfileId(), pluginId);
    let plugin = this.findPlugin(pluginId);
    if (!plugin && installed) plugin = this.installedMarketPlugin(installed);
    if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`);
    const selected = plugin.sourceId === 'installed' || !version
      ? (installed && plugin.versions.some((item) => item.version === installed.version)
          ? plugin.versions.find((item) => item.version === installed.version)!
          : latestVersion(plugin))
      : this.findVersion(plugin, version);
    const readme = await this.readReadme(plugin, selected).catch((error) => ({
      text: null,
      source: null,
      error: error instanceof Error ? error.message : String(error),
    }));
    const screenshots = plugin.screenshots?.length ? plugin.screenshots : extractScreenshots(readme.text || '');
    const verification = this.verifications[`${plugin.name}@${selected.version}`] || null;
    const runtimeNotes = [
      `DSH baseline ${DSH_BASELINE.version} (${DSH_BASELINE.commit.slice(0, 10)}); adapter ${DSH_COMPAT_LAYER_VERSION}.`,
      'Tools, commands and skills run in the ConeCode worker. Install in DSH Web to use client modules and official Web host services.',
      ...(plugin.format === 'native' ? ['ConeCode-native plugin; declared in conecode.plugin.json.'] : []),
    ];
    return {
      plugin,
      version: selected,
      versions: plugin.versions.map((item) => ({
        version: item.version,
        publishedAt: item.publishedAt,
        compatibility: this.compatibilityFor(plugin, item, this.state.activeProfileId(), installed),
        ...(item.deprecated ? { deprecated: item.deprecated } : {}),
      })),
      readme: readme.text,
      readmeSource: readme.source,
      readmeError: readme.error,
      screenshots,
      installed,
      category: MARKET_CATEGORIES.find((category) => category.id === plugin.category) || null,
      verification,
      runtimeNotes,
    };
  }

  private async readReadme(plugin: MarketPlugin, version: MarketVersion): Promise<{ text: string | null; source: string | null; error: string | null }> {
    if (plugin.readme && version.version === latestVersion(plugin).version) {
      return { text: plugin.readme, source: plugin.sourceId, error: null };
    }
    if (version.source.type === 'bundled-example' || version.source.type === 'local') {
      const readme = version.source.path ? packageReadme(version.source.path) : undefined;
      return { text: readme?.text || null, source: readme?.source || null, error: null };
    }
    const cacheFile = this.readmeCachePath(plugin.name, version.version);
    if (existsFile(cacheFile)) {
      try {
        const cached = readJson<{ text: string; source: string }>(cacheFile);
        if (cached.text) return { text: cached.text, source: cached.source, error: null };
      } catch {
        // refetch
      }
    }
    try {
      const packumentRaw = await this.fetchText(`https://registry.npmjs.org/${encodeURIComponent(plugin.name)}`, MAX_CATALOG_BYTES, 20_000, true);
      const packument = JSON.parse(packumentRaw) as { readme?: string; versions?: Record<string, { readme?: string }> };
      const text = packument.versions?.[version.version]?.readme || packument.readme;
      if (typeof text === 'string' && text.trim()) {
        const clipped = text.slice(0, MAX_README_BYTES);
        this.cacheReadme(cacheFile, clipped, 'npm registry');
        return { text: clipped, source: 'npm registry', error: null };
      }
    } catch {
      // fall through to GitHub
    }
    const repo = plugin.repository?.url || manifestRepository(plugin as unknown as RawPackageManifest)?.url;
    if (repo) {
      const match = repo.match(/github\.com\/([^/]+)\/([^/#]+)/);
      if (match) {
        for (const branch of ['HEAD', version.version]) {
          try {
            const url = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${branch}/README.md`;
            const text = (await this.fetchText(url, MAX_README_BYTES, 20_000, true)).slice(0, MAX_README_BYTES);
            this.cacheReadme(cacheFile, text, url);
            return { text, source: url, error: null };
          } catch {
            // try the next README location
          }
        }
      }
    }
    return { text: null, source: null, error: 'README is not cached and could not be fetched. Check the network and sync again.' };
  }

  private cacheReadme(cacheFile: string, text: string, source: string): void {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ text, source, fetchedAt: isoNow() }, null, 2), 'utf8');
    } catch {
      // caching is best effort
    }
  }

  private async loadAllEnabled(profileId: string): Promise<void> {
    const installed = this.state.installed(profileId);
    const hasDshPlugins = installed.some((plugin) => plugin.format === 'dsh');
    if (hasDshPlugins) {
      try {
        await this.installer.provisionRuntime(
          profileId,
          (line) => this.state.appendLog(profileId, '_runtime', line),
          new AbortController().signal,
        );
      } catch (error) {
        this.warnings.push(`Shared DSH runtime upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.runtime.ensureStarted(profileId, this.dshHome, hasDshPlugins);
    await this.restoreInstalledPlugins(profileId, installed);
  }

  private async restoreInstalledPlugins(profileId: string, installed: InstalledPlugin[]): Promise<void> {
    for (const plugin of installed) {
      const entry = syntheticMarketPlugin(plugin);
      const version = entry.versions[0];
      const compatibility = this.compatibilityFor(entry, version, profileId, null, plugin.manifestRaw);
      if (!plugin.enabled) {
        this.state.patchPlugin(profileId, plugin.id, {
          status: 'disabled', restartRequired: false, compatibility, contributions: { tools: [], commands: [], skills: [] },
        });
        continue;
      }
      try {
        const state = await this.runtime.load(this.runtimeSpec(plugin));
        this.state.patchPlugin(profileId, plugin.id, {
          status: state.status === 'loaded' ? 'loaded' : state.status,
          lastError: state.error || null,
          contributions: state.contributions || { tools: [], commands: [], skills: [] },
          requiredServices: state.requiredServices || [],
          compatibility: this.compatibilityWithProbe(entry, version, profileId, state, plugin.manifestRaw),
          clientUnsupported: plugin.clientUnsupported,
          restartRequired: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.state.appendLog(profileId, plugin.name, `activation failed: ${message}`);
        this.state.patchPlugin(profileId, plugin.id, {
          status: 'restart-required', compatibility, contributions: { tools: [], commands: [], skills: [] },
          lastError: message,
          restartRequired: true,
        });
      }
    }
    this.writeProjection(profileId);
  }

  private async reloadRuntimeAfterPackageChange(profileId: string, pluginId: string, format: InstalledPlugin['format']): Promise<void> {
    // Worker imports cache the entry and its dependencies by path. Replacing files at
    // that path needs a fresh module graph, including when the previous plugin is disabled.
    const others = this.state.installed(profileId).filter((item) => item.id !== pluginId);
    await this.runtime.shutdown();
    await this.runtime.ensureStarted(profileId, this.dshHome, format === 'dsh' || others.some((item) => item.format === 'dsh'));
    await this.restoreInstalledPlugins(profileId, others);
  }

  private async lockRuntimeMutation(): Promise<() => void> {
    const pending = this.runtimeMutations;
    let release!: () => void;
    this.runtimeMutations = new Promise<void>((resolve) => { release = resolve; });
    await pending;
    return release;
  }

  private async withRuntimeMutation<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.lockRuntimeMutation();
    try { return await work(); }
    finally { release(); }
  }

  /**
   * Compose every enabled bundle's row list in profile order, then apply each
   * bundle's non-insert patch verbs over the accumulated rows. This is the
   * subset of DSH's profile composition needed by host-side rows: later layers
   * win, an override replaces the named keys, and rows from a disabled bundle
   * do not contribute.
   */
  private effectiveRows(profileId: string, includePluginId?: string): Map<string, InstalledRow[]> {
    const installed = this.state.installed(profileId).filter((plugin) => (plugin.enabled || plugin.id === includePluginId) && plugin.format === 'dsh');
    const rows: InstalledRow[] = [];
    const owner = new Map<InstalledRow, string>();
    for (const plugin of installed) {
      for (const override of plugin.bundleOverrides || []) {
        if (Array.isArray(override.insert) || typeof override.id !== 'string') continue;
        let index = -1;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].id === override.id) { index = i; break; }
        }
        if (index < 0) continue;
        const row = rows[index];
        if (typeof override.name === 'string' && override.name !== row.name) continue;
        if (Object.prototype.hasOwnProperty.call(override, 'config')) row.config = structuredClone(override.config ?? {});
        if (typeof override.disabled === 'boolean') row.disabled = override.disabled;
        if (Array.isArray(override.inject)) row.inject = override.inject.filter((item): item is string => typeof item === 'string');
      }
      for (const row of plugin.rows) {
        const copy = { ...row, config: structuredClone(row.config ?? {}) };
        rows.push(copy);
        owner.set(copy, plugin.id);
      }
    }
    const grouped = new Map<string, InstalledRow[]>();
    for (const row of rows) {
      const pluginId = owner.get(row);
      if (!pluginId) continue;
      const list = grouped.get(pluginId) || [];
      list.push(row);
      grouped.set(pluginId, list);
    }
    return grouped;
  }

  private async refreshLayerTargets(profileId: string, layerId: string, before: Map<string, InstalledRow[]>, alreadyReloaded = false): Promise<InstalledPlugin[]> {
    const after = this.effectiveRows(profileId);
    const targets = this.state.installed(profileId).filter((plugin) =>
      plugin.id !== layerId && plugin.enabled && !isDeepStrictEqual(before.get(plugin.id), after.get(plugin.id)));
    if (targets.length && !alreadyReloaded) await this.restoreInstalledPlugins(profileId, targets);
    return targets.map((plugin) => this.state.installedByMarketId(profileId, plugin.id)!);
  }

  private runtimeSpec(plugin: InstalledPlugin): RuntimePluginSpec {
    const effective = this.effectiveRows(plugin.profileId, plugin.id).get(plugin.id) || plugin.rows;
    return {
      id: plugin.id,
      name: plugin.name,
      title: plugin.title,
      format: plugin.format,
      packageDir: plugin.packageDir,
      ...(plugin.format === 'native' ? { nativeEntryPath: plugin.entry } : {}),
      rows: effective.map((row) => ({
        id: row.id,
        name: row.name,
        entryPath: row.entryPath,
        config: row.config,
        disabled: row.disabled,
        inject: row.inject,
      })),
      enabled: plugin.enabled,
    };
  }

  private preparedToInstalled(
    prepared: PreparedPackage,
    plugin: MarketPlugin,
    version: MarketVersion,
    finalDir: string,
    previous: InstalledPlugin | null,
  ): InstalledPlugin {
    const finalPackageDir = path.join(finalDir, prepared.packageRelativeDir);
    const rows = prepared.rows.map((row) => {
      const entryPath = relocated(row.entryPath, prepared.stagingDir, finalDir);
      const prior = previous?.rows.find((item) => item.id === row.id);
      return {
        ...row,
        entryPath,
        config: prior ? prior.config : row.config,
      };
    });
    const entry = rows[0]?.entryPath || path.join(finalPackageDir, 'package.json');
    const createdAt = isoNow();
    const previousBackups = (previous?.backups || []).slice(-3);
    return {
      id: prepared.name,
      name: prepared.name,
      title: plugin.title,
      version: prepared.version,
      format: prepared.format,
      profileId: prepared.profileId,
      enabled: previous?.enabled ?? true,
      status: 'loaded',
      requestedSpec: prepared.requestedSpec,
      resolvedSpec: prepared.resolvedSpec,
      ...(prepared.integrity ? { integrity: prepared.integrity } : {}),
      installedAt: previous?.installedAt || createdAt,
      updatedAt: createdAt,
      source: version.source,
      packageDir: finalPackageDir,
      entry,
      ...(prepared.license ? { license: prepared.license } : {}),
      ...(plugin.repository ? { repository: plugin.repository } : {}),
      manifestRaw: prepared.manifest as Record<string, unknown>,
      ...(prepared.manifest.dsh ? { dsh: prepared.manifest.dsh } : {}),
      rows,
      ...(prepared.bundleOverrides.length ? { bundleOverrides: prepared.bundleOverrides } : {}),
      compatibility: this.compatibilityFor(plugin, version, prepared.profileId, previous),
      contributions: { tools: [], commands: [], skills: [] },
      backups: previousBackups,
      lastError: null,
      restartRequired: false,
      clientUnsupported: prepared.clientUnsupported,
      catalogKnown: plugin.sourceId !== 'repository-import' && plugin.sourceId !== 'local-import',
      dataKept: true,
    };
  }

  private beginOperation(
    profileId: string,
    pluginId: string,
    kind: InstallOperation['kind'],
  ): { requestId: string; controller: AbortController; operation: InstallOperation } {
    const key = `${profileId}:${pluginId}`;
    if (this.activeOperations.has(key)) {
      throw new Error('Another operation is already running for this plugin. Wait for it to finish or cancel it first.');
    }
    const requestId = makeRequestId();
    const controller = new AbortController();
    this.activeOperations.set(key, { requestId, controller, kind });
    const operation: InstallOperation = {
      requestId,
      pluginId,
      profileId,
      kind,
      phase: 'queued',
      message: 'Queued',
      startedAt: isoNow(),
    };
    this.state.recordOperation(operation);
    this.emit({ type: 'operation', operation });
    return { requestId, controller, operation };
  }

  private updateOperation(operation: InstallOperation, patch: Partial<InstallOperation>): void {
    Object.assign(operation, patch);
    this.state.recordOperation(operation);
    this.emit({ type: 'operation', operation: { ...operation } });
  }

  cancel(requestId: string): void {
    for (const active of this.activeOperations.values()) {
      if (active.requestId === requestId) {
        active.controller.abort();
        const op = this.state.operations().find((item) => item.requestId === requestId);
        if (op) this.updateOperation(op, { phase: 'cancelled', message: 'Cancelling…' });
        return;
      }
    }
    throw new Error('No active operation with that request id.');
  }

  async install(profileId: string, pluginId: string, version?: string, options: { acceptRisk?: boolean; allowScripts?: boolean } = {}): Promise<InstalledPlugin> {
    await this.ensureReady();
    validateProfileId(profileId);
    const plugin = this.findPlugin(pluginId);
    if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`);
    const selected = this.findVersion(plugin, version);
    const previous = this.state.installedByMarketId(profileId, plugin.name);
    if (previous && previous.version === selected.version) throw new Error(`${plugin.name}@${selected.version} is already installed. Use update or rollback.`);
    if (previous) return this.installVersion(profileId, plugin, selected, previous, { ...options, kind: 'update' });
    return this.installVersion(profileId, plugin, selected, null, { ...options, kind: 'install' });
  }

  private async installVersion(
    profileId: string,
    plugin: MarketPlugin,
    selected: MarketVersion,
    previous: InstalledPlugin | null,
    options: { acceptRisk?: boolean; allowScripts?: boolean; kind: 'install' | 'update' },
  ): Promise<InstalledPlugin> {
    this.requireActiveProfile(profileId);
    const compatibility = this.compatibilityFor(plugin, selected, profileId, previous);
    if (compatibility.state === 'incompatible' && !options.acceptRisk) {
      throw new Error(`Incompatible plugin: ${compatibility.reasons.map((reason) => reason.message).join(' ')}`);
    }
    if (options.acceptRisk && compatibility.state === 'incompatible') {
      this.state.setExemption(profileId, `${plugin.name}@${selected.version}`, DSH_BASELINE.version, true);
    }
    const begin = this.beginOperation(profileId, plugin.name, options.kind);
    const packageKey = `${profileId}:${plugin.name}`;
    const log = (line: string) => {
      this.state.appendLog(profileId, plugin.name, line);
      this.emit({ type: 'log', pluginId: plugin.name, message: line, level: /error|fail/i.test(line) ? 'error' : 'info' });
    };
    let prepared: PreparedPackage | null = null;
    let swapped: { finalDir: string; backupDir: string | null } | null = null;
    let releaseRuntime: (() => void) | undefined;
    try {
      this.updateOperation(begin.operation, { phase: 'resolving', message: `Resolving ${plugin.name}@${selected.version}` });
      const spec = buildInstallSpec(plugin.name, selected.version, selected.source);
      this.updateOperation(begin.operation, { phase: 'installing', message: `Installing ${spec.spec}` });
      prepared = await this.installer.prepare({
        profileId,
        requestId: begin.requestId,
        name: plugin.name,
        version: selected.version,
        source: selected.source,
        expectedIntegrity: selected.integrity,
        allowScripts: options.allowScripts,
        onLog: log,
        signal: begin.controller.signal,
      });
      if (!prepared.rows.length && !prepared.bundleOverrides.length) throw new Error('The bundle patch has no mountable rows or overrides.');
      if (prepared.format !== plugin.format) throw new Error(`Installed package format ${prepared.format} differs from catalog format ${plugin.format}.`);
      const resolvedCompatibility = this.compatibilityFor(plugin, selected, profileId, null, prepared.manifest);
      if (resolvedCompatibility.state === 'incompatible') {
        if (!options.acceptRisk) throw new Error(`Incompatible plugin: ${resolvedCompatibility.reasons.map((reason) => reason.message).join(' ')}`);
        this.state.setExemption(profileId, `${plugin.name}@${selected.version}`, DSH_BASELINE.version, true);
      }
      releaseRuntime = await this.lockRuntimeMutation();
      this.requireActiveProfile(profileId);
      if (begin.controller.signal.aborted) throw new InstallCancelledError();
      previous = this.state.installedByMarketId(profileId, plugin.name);
      const before = this.runtime.getInfo();
      await this.runtime.ensureStarted(profileId, this.dshHome, prepared.format === 'dsh');
      // Provisioning DSH storage can replace the worker used by native
      // plugins. Restore its active plugins before probing the new bundle.
      if (!before.available || before.profileId !== profileId ||
          before.threadId !== this.runtime.getInfo().threadId) {
        await this.restoreInstalledPlugins(profileId, this.state.installed(profileId));
      }
      this.updateOperation(begin.operation, { phase: 'probing', message: 'Probing the plugin in an isolated Cordis scope' });
      const probe = await this.runtime.probe(this.probeSpec(prepared));
      if (begin.controller.signal.aborted) throw new InstallCancelledError();
      if (!probe.ok) throw new Error(`Plugin failed its activation probe: ${probe.error || probe.state?.error || 'unknown error'}`);
      const probedCompatibility = this.compatibilityWithProbe(plugin, selected, profileId, probe.state!, prepared.manifest);

      if (begin.controller.signal.aborted) throw new InstallCancelledError();
      this.updateOperation(begin.operation, { phase: 'activating', message: 'Swapping the verified package into the profile' });
      swapped = this.installer.swapIn(prepared);
      if (previous?.format === 'dsh' && prepared.format === 'native') this.installer.unlinkPlugin(profileId, previous.name);
      this.installer.linkPlugin(profileId, prepared.name, swapped.finalDir, prepared.packageRelativeDir);
      const record = this.preparedToInstalled(prepared, plugin, selected, swapped.finalDir, previous);
      const beforeLayers = this.effectiveRows(profileId);
      record.compatibility = probedCompatibility;
      if (previous?.enabled === false) record.enabled = false;
      if (previous) {
        if (swapped.backupDir) record.backups = [...previous.backups, backupRecord(previous, swapped.backupDir)].slice(-3);
      }
      this.state.updatePlugin(profileId, record);
      const restarted = !!previous || this.uninstalledPackages.has(packageKey);
      if (restarted) {
        await this.reloadRuntimeAfterPackageChange(profileId, record.id, record.format);
      }
      if (record.enabled) {
        const loaded = await this.runtime.load(this.runtimeSpec(record));
        if (begin.controller.signal.aborted) throw new InstallCancelledError();
        if (loaded.status !== 'loaded' && loaded.status !== 'disabled') {
          throw new Error(`Plugin failed to activate in the profile: ${loaded.error || loaded.status}`);
        }
        record.status = loaded.status;
        record.lastError = null;
        record.contributions = loaded.contributions || { tools: [], commands: [], skills: [] };
        record.requiredServices = loaded.requiredServices || record.requiredServices || [];
        this.state.updatePlugin(profileId, record);
      } else {
        record.status = 'disabled';
        this.state.updatePlugin(profileId, record);
      }
      const targets = await this.refreshLayerTargets(profileId, record.id, beforeLayers, restarted);
      const failedTarget = targets.find((target) => target.status !== 'loaded' && target.status !== 'disabled');
      if (failedTarget) throw new Error(`The bundle override failed to activate ${failedTarget.name}: ${failedTarget.lastError || failedTarget.status}`);
      if (begin.controller.signal.aborted) throw new InstallCancelledError();
      this.installer.removeBackup(swapped.backupDir && !record.backups.some((item) => item.directory === swapped!.backupDir) ? swapped.backupDir : null);
      this.writeProjection(profileId);
      this.uninstalledPackages.delete(packageKey);
      this.updateOperation(begin.operation, { phase: 'done', message: `${options.kind === 'update' ? 'Updated' : 'Installed'} ${plugin.name}@${selected.version}`, finishedAt: isoNow() });
      this.emit({ type: 'installed', pluginId: record.id });
      return record;
    } catch (error) {
      const cancelled = error instanceof InstallCancelledError || begin.controller.signal.aborted;
      const message = cancelled ? 'Cancelled' : error instanceof Error ? error.message : String(error);
      log(`${cancelled ? 'Cancelled' : 'Failed'}: ${message}`);
      if (swapped) {
        try {
          if (previous) {
            if (swapped.backupDir && fs.existsSync(swapped.backupDir)) {
              this.installer.restore(swapped.finalDir, swapped.backupDir);
              if (previous.format === 'native' && prepared?.format === 'dsh') this.installer.unlinkPlugin(profileId, previous.name);
              this.installer.linkPlugin(profileId, previous.name, swapped.finalDir, previous.format === 'native' ? '.' : `node_modules/${previous.name}`);
              this.state.updatePlugin(profileId, previous);
              await this.reloadRuntimeAfterPackageChange(profileId, previous.id, previous.format);
              if (previous.enabled) await this.runtime.load(this.runtimeSpec(previous)).catch(() => {});
            } else {
              // No backup was found: keep the previous state but mark the
              // plugin as needing a manual reinstall rather than claiming success.
              this.state.patchPlugin(profileId, previous.id, { status: 'restart-required', restartRequired: true, lastError: message });
            }
          } else {
            const beforeLayers = this.effectiveRows(profileId);
            await this.runtime.unload(plugin.name).catch(() => {});
            fs.rmSync(swapped.finalDir, { recursive: true, force: true });
            this.installer.unlinkPlugin(profileId, plugin.name);
            this.state.removePlugin(profileId, plugin.name);
            await this.refreshLayerTargets(profileId, plugin.name, beforeLayers);
          }
          this.writeProjection(profileId);
        } catch (rollbackError) {
          log(`Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (prepared) {
        fs.rmSync(prepared.stagingDir, { recursive: true, force: true });
      }
      this.updateOperation(begin.operation, {
        phase: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Installation cancelled' : 'Installation failed',
        error: message,
        finishedAt: isoNow(),
      });
      this.emit({ type: 'installed', pluginId: plugin.name });
      throw error;
    } finally {
      releaseRuntime?.();
      this.activeOperations.delete(`${profileId}:${plugin.name}`);
    }
  }

  private probeSpec(prepared: PreparedPackage): RuntimePluginSpec {
    if (prepared.format === 'native') {
      return {
        id: prepared.name,
        name: prepared.name,
        title: prepared.name,
        format: 'native',
        packageDir: prepared.packageDir,
        nativeEntryPath: prepared.rows[0]?.entryPath,
        rows: prepared.rows,
        enabled: true,
      };
    }
    return {
      id: prepared.name,
      name: prepared.name,
      title: prepared.name,
      format: 'dsh',
      packageDir: prepared.packageDir,
      rows: prepared.rows.map((row) => ({
        id: row.id,
        name: row.name,
        entryPath: row.entryPath,
        config: row.config,
        disabled: row.disabled,
        inject: row.inject,
      })),
      enabled: true,
    };
  }

  async inspectLocalPlugin(directory: string): Promise<{ plugin: MarketPlugin; version: MarketVersion; warnings: string[]; compatibility: CompatibilityResult }> {
    const dir = path.resolve(directory);
    if (!fs.existsSync(dir)) throw new Error(`Directory not found: ${dir}`);
    const native = readNativeManifest(dir);
    let plugin: MarketPlugin;
    const warnings: string[] = [];
    if (native) {
      plugin = {
        id: native.name,
        name: native.name,
        format: 'native',
        title: native.name,
        description: native.description || '',
        author: native.author,
        homepage: native.homepage,
        repository: native.repository ? { url: native.repository } : undefined,
        license: native.license,
        category: 'native',
        labels: ['local', 'native'],
        keywords: [],
        declared: {},
        versions: [{
          version: native.version,
          publishedAt: isoNow(),
          source: { type: 'local', path: dir },
          engines: {},
          peerDependencies: {},
          dependencies: {},
        }],
        sourceId: 'local-import',
        readme: packageReadme(dir, native.readme)?.text,
      };
    } else {
      const manifest = readPackageManifest(dir);
      const patches = loadBundlePatches(dir, manifest);
      warnings.push(...patches.warnings);
      if (!manifest.version) throw new Error('Local package has no version');
      plugin = {
        id: manifest.name!,
        name: manifest.name!,
        format: 'dsh',
        title: manifest.name!,
        description: manifest.description || '',
        author: manifestAuthor(manifest),
        homepage: manifest.homepage,
        repository: manifestRepository(manifest),
        license: manifest.license,
        category: manifest.dsh?.client ? 'interface' : 'tools',
        labels: ['local'],
        keywords: Array.isArray(manifest.keywords) ? manifest.keywords.filter((item): item is string => typeof item === 'string') : [],
        dsh: manifest.dsh,
        declared: {
          engines: Object.fromEntries(Object.entries(manifest.engines || {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
          peerDependencies: Object.fromEntries(Object.entries(manifest.peerDependencies || {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
          dsh: manifest.dsh,
        },
        versions: [{
          version: manifest.version,
          publishedAt: isoNow(),
          source: { type: 'local', path: dir },
          engines: {
            ...(typeof manifest.engines?.dsh === 'string' ? { dsh: manifest.engines.dsh } : {}),
            ...(typeof manifest.engines?.node === 'string' ? { node: manifest.engines.node } : {}),
          },
          peerDependencies: Object.fromEntries(Object.entries(manifest.peerDependencies || {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
          dependencies: Object.fromEntries(Object.entries(manifest.dependencies || {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
        }],
        sourceId: 'local-import',
        readme: packageReadme(dir)?.text,
      };
    }
    const version = plugin.versions[0];
    return { plugin, version, warnings, compatibility: this.compatibilityFor(plugin, version, this.state.activeProfileId()) };
  }

  async inspectRepository(input: string, ref?: string, subdir?: string): Promise<RepositoryInspection> {
    await this.ensureReady();
    const inspection = await inspectRemoteRepository(input, ref, subdir, path.join(this.state.cacheDir(), 'repositories'));
    const profileId = this.state.activeProfileId();
    const installed = this.state.installedByMarketId(profileId, inspection.plugin.name);
    return {
      ...inspection,
      compatibility: this.compatibilityFor(inspection.plugin, inspection.version, profileId, installed),
    };
  }

  async installRepository(
    profileId: string,
    url: string,
    commit: string,
    subdir?: string,
    options: { acceptRisk?: boolean; allowScripts?: boolean } = {},
  ): Promise<InstalledPlugin> {
    await this.ensureReady();
    const pinned = validateGitUrl(`${url}#${commit}`);
    if (pinned.commit !== commit) throw new Error('Installation requires the exact commit from the repository preview.');
    const inspection = await this.inspectRepository(pinned.url, pinned.commit, subdir);
    const previous = this.state.installedByMarketId(profileId, inspection.plugin.name);
    return this.installVersion(profileId, inspection.plugin, inspection.version, previous, {
      acceptRisk: options.acceptRisk,
      allowScripts: options.allowScripts,
      kind: previous ? 'update' : 'install',
    });
  }

  async installLocal(profileId: string, directory: string, options: { acceptRisk?: boolean; allowScripts?: boolean } = {}): Promise<InstalledPlugin> {
    await this.ensureReady();
    const inspected = await this.inspectLocalPlugin(directory);
    const previous = this.state.installedByMarketId(profileId, inspected.plugin.name);
    return this.installVersion(profileId, inspected.plugin, inspected.version, previous, {
      acceptRisk: options.acceptRisk,
      allowScripts: options.allowScripts,
      kind: previous ? 'update' : 'install',
    });
  }

  async rollback(profileId: string, pluginId: string, version?: string): Promise<InstalledPlugin> {
    await this.ensureReady();
    return this.withRuntimeMutation(() => this.applyRollback(profileId, pluginId, version));
  }

  private async applyRollback(profileId: string, pluginId: string, version?: string): Promise<InstalledPlugin> {
    this.requireActiveProfile(profileId);
    const plugin = this.state.installedByMarketId(profileId, pluginId);
    if (!plugin) throw new Error(`Plugin ${pluginId} is not installed in profile ${profileId}.`);
    const backup = [...plugin.backups].reverse().find((item) =>
      (!version || item.version === version) && item.directory && fs.existsSync(item.directory));
    if (!backup) {
      throw new Error('No usable rollback package is recorded for this plugin.');
    }
    const directoryName = pluginDirName(plugin);
    const backupRoot = path.join(this.state.backupsDir(profileId), directoryName);
    const target = assertInside(backupRoot, backup.directory, 'Rollback package');
    if (target === fs.realpathSync(backupRoot)) throw new Error('Invalid rollback package directory.');
    const finalDir = this.installer.finalDirectory(profileId, directoryName);
    const currentBackup = path.join(backupRoot, `pre-rollback-${makeRequestId()}`);
    const begin = this.beginOperation(profileId, plugin.name, 'rollback');
    const log = (line: string) => {
      this.state.appendLog(profileId, plugin.name, line);
      this.emit({ type: 'log', pluginId: plugin.name, message: line });
    };
    let unloaded = false;
    let currentMoved = false;
    let backupMoved = false;
    let rebuilt: InstalledPlugin | undefined;
    try {
      this.updateOperation(begin.operation, { phase: 'activating', message: `Rolling back to ${backup.version}` });
      rebuilt = this.readRollbackPackage(plugin, backup, target, finalDir, currentBackup);
      const before = this.runtime.getInfo();
      await this.runtime.ensureStarted(profileId, this.dshHome, rebuilt.format === 'dsh');
      if (before.threadId !== this.runtime.getInfo().threadId) {
        await this.restoreInstalledPlugins(profileId, this.state.installed(profileId));
      }
      if (begin.controller.signal.aborted) throw new InstallCancelledError();
      if (plugin.enabled) {
        unloaded = true;
        await this.runtime.unload(plugin.id);
      }
      if (begin.controller.signal.aborted) throw new InstallCancelledError();
      fs.renameSync(finalDir, currentBackup);
      currentMoved = true;
      fs.renameSync(target, finalDir);
      backupMoved = true;
      if (plugin.format === 'dsh' && rebuilt.format === 'native') this.installer.unlinkPlugin(profileId, plugin.name);
      this.installer.linkPlugin(profileId, rebuilt.name, finalDir, path.relative(finalDir, rebuilt.packageDir) || '.');
      const beforeLayers = this.effectiveRows(profileId);
      this.state.updatePlugin(profileId, rebuilt);
      await this.reloadRuntimeAfterPackageChange(profileId, rebuilt.id, rebuilt.format);
      const failedTarget = (await this.refreshLayerTargets(profileId, rebuilt.id, beforeLayers, true))
        .find((target) => target.status !== 'loaded' && target.status !== 'disabled');
      if (failedTarget) throw new Error(`The bundle override failed to activate ${failedTarget.name}: ${failedTarget.lastError || failedTarget.status}`);
      if (rebuilt.enabled) {
        const loaded = await this.runtime.load(this.runtimeSpec(rebuilt));
        if (begin.controller.signal.aborted) throw new InstallCancelledError();
        if (loaded.status !== 'loaded' && loaded.status !== 'disabled') throw new Error(loaded.error || `Rollback activation failed (${loaded.status}).`);
        rebuilt.status = loaded.status;
        rebuilt.contributions = loaded.contributions || { tools: [], commands: [], skills: [] };
        rebuilt.requiredServices = loaded.requiredServices || [];
        const catalogEntry = syntheticMarketPlugin(rebuilt);
        rebuilt.compatibility = this.compatibilityWithProbe(catalogEntry, catalogEntry.versions[0], profileId, loaded, rebuilt.manifestRaw);
        this.state.updatePlugin(profileId, rebuilt);
      }
      this.writeProjection(profileId);
      this.updateOperation(begin.operation, { phase: 'done', message: `Rolled back to ${backup.version}`, finishedAt: isoNow() });
      this.emit({ type: 'installed', pluginId: rebuilt.id });
      return rebuilt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Rollback failed: ${message}`);
      if (currentMoved || unloaded) {
        try {
          if (backupMoved) {
            if (plugin.enabled) await this.runtime.unload(plugin.id).catch(() => {});
            fs.renameSync(finalDir, target);
          }
          if (currentMoved) fs.renameSync(currentBackup, finalDir);
          this.state.updatePlugin(profileId, plugin);
          if (backupMoved && plugin.format === 'native' && rebuilt?.format === 'dsh') this.installer.unlinkPlugin(profileId, plugin.name);
          this.installer.linkPlugin(profileId, plugin.name, finalDir, path.relative(finalDir, plugin.packageDir) || '.');
          if (backupMoved) await this.reloadRuntimeAfterPackageChange(profileId, plugin.id, plugin.format);
          if (plugin.enabled) {
            const restored = await this.runtime.load(this.runtimeSpec(plugin));
            if (restored.status !== 'loaded') throw new Error(restored.error || 'Could not reactivate the previous version.');
          }
        } catch (restoreError) {
          const recoveryError = restoreError instanceof Error ? restoreError.message : String(restoreError);
          log(`Could not restore the previous version: ${recoveryError}`);
          this.state.patchPlugin(profileId, plugin.id, { status: 'restart-required', restartRequired: true, lastError: recoveryError });
        }
        this.writeProjection(profileId);
      }
      const cancelled = error instanceof InstallCancelledError;
      this.updateOperation(begin.operation, { phase: cancelled ? 'cancelled' : 'failed', message: cancelled ? 'Rollback cancelled' : 'Rollback failed', error: message, finishedAt: isoNow() });
      this.emit({ type: 'installed', pluginId: plugin.id });
      throw error;
    } finally {
      this.activeOperations.delete(`${profileId}:${plugin.name}`);
    }
  }

  private readRollbackPackage(plugin: InstalledPlugin, backup: BackupRecord, target: string, finalDir: string, currentBackup: string): InstalledPlugin {
    const native = readNativeManifest(target);
    const packageRelativeDir = native ? '.' : path.join('node_modules', ...plugin.name.split('/'));
    const targetPackage = path.join(target, packageRelativeDir);
    const manifest = native ? nativeManifestToPackage(native) : readPackageManifest(targetPackage);
    if (manifest.name !== plugin.name || manifest.version !== backup.version) {
      throw new Error(`Rollback package is ${manifest.name}@${manifest.version}, expected ${plugin.name}@${backup.version}.`);
    }
    const patches = native ? null : loadBundlePatches(targetPackage, manifest);
    const packageDir = path.join(finalDir, packageRelativeDir);
    const toFinalPath = (file: string) => relocated(file, target, finalDir);
    const rows: InstalledRow[] = patches
      ? rowsFromPatches(targetPackage, plugin.name, patches).map((row) => ({ ...row, entryPath: toFinalPath(row.entryPath) }))
      : [{ id: 'native', name: plugin.name, entryPath: path.join(packageDir, native!.entry), config: {}, disabled: false, inject: [] }];
    const overrides = patches ? bundleOverrides(patches) : [];
    if (!rows.length && !overrides.length) throw new Error('Rollback package has no mountable rows or overrides.');
    const rebuilt: InstalledPlugin = {
      ...plugin,
      ...backup.installation,
      source: backup.installation?.source,
      requestedSpec: backup.installation?.requestedSpec ?? `backup:${plugin.name}@${backup.version}`,
      resolvedSpec: backup.installation?.resolvedSpec ?? `${plugin.name}@${backup.version}`,
      integrity: backup.integrity,
      version: backup.version,
      format: native ? 'native' : 'dsh',
      status: plugin.enabled ? 'loaded' : 'disabled',
      updatedAt: isoNow(),
      rows: rows.map((row) => {
        const previous = plugin.rows.find((item) => item.id === row.id);
        return previous ? { ...row, config: previous.config } : row;
      }),
      entry: rows[0]?.entryPath || path.join(packageDir, 'package.json'),
      packageDir,
      dsh: manifest.dsh,
      manifestRaw: manifest,
      license: manifest.license,
      repository: manifestRepository(manifest),
      bundleOverrides: overrides,
      clientUnsupported: !native && !!manifest.dsh?.client,
      backups: [...plugin.backups.filter((item) => item.directory !== backup.directory), backupRecord(plugin, currentBackup)].slice(-3),
      lastError: null,
      restartRequired: false,
      requiredServices: [],
      contributions: { tools: [], commands: [], skills: [] },
    };
    const catalogEntry = syntheticMarketPlugin(rebuilt);
    rebuilt.compatibility = this.compatibilityFor(catalogEntry, catalogEntry.versions[0], plugin.profileId, null, rebuilt.manifestRaw);
    return rebuilt;
  }

  async uninstall(profileId: string, pluginId: string, deleteData = false): Promise<void> {
    await this.ensureReady();
    return this.withRuntimeMutation(() => this.applyUninstall(profileId, pluginId, deleteData));
  }

  private async applyUninstall(profileId: string, pluginId: string, deleteData: boolean): Promise<void> {
    this.requireActiveProfile(profileId);
    const plugin = this.state.installedByMarketId(profileId, pluginId);
    if (!plugin) throw new Error(`Plugin ${pluginId} is not installed in profile ${profileId}.`);
    const begin = this.beginOperation(profileId, plugin.name, 'uninstall');
    try {
      this.updateOperation(begin.operation, { phase: 'activating', message: 'Unloading plugin contributions' });
      await this.runtime.ensureStarted(profileId, this.dshHome);
      await this.runtime.unload(plugin.id).catch(() => {});
      const contributions = await this.runtime.contributions(plugin.id).catch(() => ({ tools: [], commands: [], skills: [] }));
      if (contributions.tools.length || contributions.commands.length || contributions.skills.length) {
        throw new Error('Runtime still owns contributions after unload; refusing to delete the package.');
      }
      this.installer.unlinkPlugin(profileId, plugin.name);
      const finalDir = this.installer.finalDirectory(profileId, pluginDirName(plugin));
      fs.rmSync(finalDir, { recursive: true, force: true });
      const backupRoot = path.join(this.state.backupsDir(profileId), pluginDirName(plugin));
      fs.rmSync(backupRoot, { recursive: true, force: true });
      if (deleteData) fs.rmSync(path.join(this.state.dataDir(profileId), pluginDirName(plugin)), { recursive: true, force: true });
      const beforeLayers = this.effectiveRows(profileId);
      this.state.removePlugin(profileId, plugin.id);
      await this.refreshLayerTargets(profileId, plugin.id, beforeLayers);
      this.uninstalledPackages.add(`${profileId}:${plugin.name}`);
      this.writeProjection(profileId);
      this.updateOperation(begin.operation, {
        phase: 'done',
        message: `Uninstalled ${plugin.name}${deleteData ? ' and deleted its data' : '; plugin data was kept'}`,
        finishedAt: isoNow(),
      });
      this.emit({ type: 'installed', pluginId: plugin.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.appendLog(profileId, plugin.name, `Uninstall failed: ${message}`);
      this.updateOperation(begin.operation, { phase: 'failed', message: 'Uninstall failed', error: message, finishedAt: isoNow() });
      throw error;
    } finally {
      this.activeOperations.delete(`${profileId}:${plugin.name}`);
    }
  }

  async setEnabled(profileId: string, pluginId: string, enabled: boolean): Promise<InstalledPlugin> {
    await this.ensureReady();
    return this.withRuntimeMutation(() => this.applyEnabled(profileId, pluginId, enabled));
  }

  private async applyEnabled(profileId: string, pluginId: string, enabled: boolean): Promise<InstalledPlugin> {
    this.requireActiveProfile(profileId);
    let plugin = this.state.installedByMarketId(profileId, pluginId);
    if (!plugin) throw new Error(`Plugin ${pluginId} is not installed in profile ${profileId}.`);
    if (plugin.enabled === enabled) return plugin;
    const beforeLayers = this.effectiveRows(profileId);
    await this.runtime.ensureStarted(profileId, this.dshHome);
    if (!enabled) {
      await this.runtime.unload(plugin.id);
      plugin = this.state.patchPlugin(profileId, plugin.id, {
        enabled: false,
        status: 'disabled',
        contributions: { tools: [], commands: [], skills: [] },
        restartRequired: false,
      });
    } else {
      const loaded = await this.runtime.load(this.runtimeSpec({ ...plugin, enabled: true }));
      plugin = this.state.patchPlugin(profileId, plugin.id, {
        enabled: true,
        status: loaded.status === 'loaded' ? 'loaded' : loaded.status,
        lastError: loaded.error || null,
        contributions: loaded.contributions || { tools: [], commands: [], skills: [] },
        requiredServices: loaded.requiredServices || [],
        restartRequired: false,
      });
    }
    const targets = await this.refreshLayerTargets(profileId, plugin.id, beforeLayers);
    const failedTarget = enabled && targets.find((target) => target.status !== 'loaded' && target.status !== 'disabled');
    if (failedTarget) {
      await this.applyEnabled(profileId, plugin.id, false);
      throw new Error(`The bundle override failed to activate ${failedTarget.name}: ${failedTarget.lastError || failedTarget.status}`);
    }
    this.writeProjection(profileId);
    this.emit({ type: 'installed', pluginId: plugin.id });
    return plugin;
  }

  async saveConfig(profileId: string, pluginId: string, rowConfigs: Record<string, unknown>): Promise<InstalledPlugin> {
    await this.ensureReady();
    return this.withRuntimeMutation(() => this.applyConfig(profileId, pluginId, rowConfigs));
  }

  private async applyConfig(profileId: string, pluginId: string, rowConfigs: Record<string, unknown>): Promise<InstalledPlugin> {
    this.requireActiveProfile(profileId);
    const plugin = this.state.installedByMarketId(profileId, pluginId);
    if (!plugin) throw new Error(`Plugin ${pluginId} is not installed in profile ${profileId}.`);
    const previous = structuredClone(plugin);
    const rows = plugin.rows.map((row) => Object.prototype.hasOwnProperty.call(rowConfigs, row.id)
      ? { ...row, config: rowConfigs[row.id] }
      : row);
    let next = this.state.patchPlugin(profileId, plugin.id, { rows });
    try {
      await this.runtime.ensureStarted(profileId, this.dshHome);
      if (next.enabled) {
        const loaded = await this.runtime.load(this.runtimeSpec(next));
        if (loaded.status !== 'loaded') throw new Error(loaded.error || 'Configuration was rejected by the plugin');
        next = this.state.patchPlugin(profileId, plugin.id, {
          status: 'loaded',
          lastError: null,
          contributions: loaded.contributions || { tools: [], commands: [], skills: [] },
          requiredServices: loaded.requiredServices || [],
          restartRequired: false,
        });
      }
      this.writeProjection(profileId);
      this.emit({ type: 'installed', pluginId: next.id });
      return next;
    } catch (error) {
      this.state.updatePlugin(profileId, previous);
      if (previous.enabled) await this.runtime.load(this.runtimeSpec(previous)).catch(() => {});
      this.writeProjection(profileId);
      throw error;
    }
  }

  async switchProfile(profileId: string): Promise<void> {
    await this.ensureReady();
    return this.withRuntimeMutation(() => this.applyProfileSwitch(profileId));
  }

  private async applyProfileSwitch(profileId: string): Promise<void> {
    validateProfileId(profileId);
    if (this.activeOperations.size > 0) throw new Error('Finish or cancel active plugin operations before switching profiles.');
    if (this.state.activeProfileId() === profileId) return;
    this.state.profile(profileId);
    await this.runtime.shutdown();
    this.state.setActiveProfile(profileId);
    this.state.ensureProfileDirs(profileId);
    this.writeProjection(profileId);
    await this.loadAllEnabled(profileId);
    this.emit({ type: 'runtime', message: `Switched to profile ${profileId}` });
  }

  createProfile(profileId: string, name?: string): MarketProfile {
    validateProfileId(profileId);
    const profile = this.state.createProfile(profileId, name);
    this.writeProjection(profile.id);
    return this.profiles().find((item) => item.id === profile.id)!;
  }

  async restartRuntime(): Promise<void> {
    return this.withRuntimeMutation(async () => {
      if (this.activeOperations.size > 0) throw new Error('Finish or cancel active plugin operations before restarting the runtime.');
      await this.runtime.shutdown();
      await this.loadAllEnabled(this.state.activeProfileId());
      this.emit({ type: 'runtime', message: 'Runtime restarted' });
    });
  }

  async invokeTool(profileId: string, pluginId: string, toolName: string, args: unknown, rowId?: string): Promise<InvokeResult> {
    await this.ensureReady();
    await this.runtimeMutations;
    this.requireActiveProfile(profileId);
    const plugin = this.state.installedByMarketId(profileId, pluginId);
    if (!plugin) throw new Error(`Plugin ${pluginId} is not installed.`);
    if (!plugin.enabled) throw new Error(`Plugin ${plugin.name} is disabled.`);
    const result = await this.runtime.invokeTool(plugin.id, rowId || null, toolName, args);
    this.state.appendLog(profileId, plugin.name, `tool ${toolName}: ${result.ok ? 'ok' : 'error'} (${result.durationMs}ms)${result.error ? ` — ${result.error}` : ''}`);
    return result;
  }

  async invokeCommand(profileId: string, pluginId: string, commandName: string, rawInput: string, rowId?: string): Promise<InvokeResult> {
    await this.ensureReady();
    await this.runtimeMutations;
    this.requireActiveProfile(profileId);
    const plugin = this.state.installedByMarketId(profileId, pluginId);
    if (!plugin) throw new Error(`Plugin ${pluginId} is not installed.`);
    if (!plugin.enabled) throw new Error(`Plugin ${plugin.name} is disabled.`);
    const result = await this.runtime.invokeCommand(plugin.id, rowId || null, commandName, rawInput);
    this.state.appendLog(profileId, plugin.name, `command ${commandName}: ${result.ok ? 'ok' : 'error'} (${result.durationMs}ms)${result.error ? ` — ${result.error}` : ''}`);
    return result;
  }

  async listSkills(): Promise<SkillContribution[]> {
    await this.ensureReady();
    return this.runtime.listSkills();
  }

  async getSkill(pluginId: string, name: string, rowId?: string): Promise<string | null> {
    await this.ensureReady();
    const plugin = this.state.installedByMarketId(this.state.activeProfileId(), pluginId);
    const skill = await this.runtime.getSkill(plugin?.id || pluginId, name, rowId);
    return skill?.content || null;
  }

  async logs(profileId: string, pluginId: string): Promise<LogsResult> {
    const plugin = this.state.installedByMarketId(profileId, pluginId);
    return this.state.readLog(profileId, plugin?.name || pluginId);
  }

  async openDshWeb(profileId: string, pluginId?: string, version?: string): Promise<string> {
    await this.ensureReady();
    this.state.profile(profileId);
    const home = path.join(this.state.profileDir(profileId), 'official-web');
    if (pluginId === undefined && version === undefined) return this.web.open(home);
    const plugin = pluginId && this.findPlugin(pluginId);
    if (!plugin || plugin.format !== 'dsh' || !version) throw new Error('Choose an exact DSH catalog version.');
    return this.web.open(home, { name: plugin.name, version: this.findVersion(plugin, version) });
  }

  private chatEntries() {
    return this.state.installed().filter((plugin) => plugin.enabled && plugin.status === 'loaded').flatMap((plugin) => {
      const entries = [
        ...plugin.contributions.tools.map((tool) => ({
          kind: 'tool' as const, item: tool, inputSchema: tool.parameters, label: `DSH ${plugin.title}`,
        })),
        ...plugin.contributions.commands.map((command) => ({
          kind: 'command' as const, item: command, label: `DSH command ${plugin.title}`,
          inputSchema: { type: 'object', properties: { input: { type: 'string', description: command.inputHint || 'Raw command input' } } },
        })),
      ];
      const counts = new Map<string, number>();
      for (const { kind, item } of entries) {
        const key = `${kind}:${item.name}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      return entries.map(({ kind, item, label, inputSchema }) => {
        const duplicate = counts.get(`${kind}:${item.name}`)! > 1;
        const server = duplicate ? chatServerName(plugin.id, kind, item.rowId) : item.chatServer;
        return {
          pluginId: plugin.id, rowId: item.rowId, kind,
          tool: { server, name: item.name, description: `[${label}${duplicate ? ` / ${item.rowId}` : ''}] ${item.description || item.name}`, inputSchema },
        };
      });
    });
  }

  async listSystemPrompts(context?: unknown): Promise<Array<{ pluginId: string; rowId: string; id: string; title?: string; content: string; priority: number }>> {
    await this.ensureReady();
    if (!this.runtime.getInfo().available) return [];
    return this.runtime.listSystemPrompts(context).catch(() => []);
  }

  async getShellEnv(): Promise<Record<string, string>> {
    await this.ensureReady();
    if (!this.runtime.getInfo().available) return {};
    return this.runtime.getShellEnv().catch(() => ({}));
  }

  async listChatTools() {
    await this.ensureReady();
    const tools = this.chatEntries().map((entry) => entry.tool);
    const skills = this.runtime.getInfo().available ? await this.runtime.listSkills().catch(() => []) : [];
    if (skills.length > 0) {
      const names = skills.slice(0, 20).map((s) => `${s.pluginId}:${s.name}`).join(', ');
      tools.push({
        server: 'dsh_skills_bridge',
        name: 'read_dsh_skill',
        description: `[DSH Skills] Read full instructions for an installed DSH plugin skill (${skills.length} available: ${names}).`,
        inputSchema: {
          type: 'object',
          properties: {
            pluginId: { type: 'string', description: 'Installed DSH plugin id or name' },
            name: { type: 'string', description: 'Skill name to read' },
            rowId: { type: 'string', description: 'Optional row id if multiple rows provide the same skill' },
          },
          required: ['name'],
        },
      });
    }
    return tools;
  }

  async callChatTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureReady();
    if (!isDshChatServer(server)) throw new Error(`Not a DSH market server: ${server}`);
    if (server === 'dsh_skills_bridge' && tool === 'read_dsh_skill') {
      const skillName = typeof args.name === 'string' ? args.name.trim() : '';
      if (!skillName) throw new Error('read_dsh_skill requires a skill name.');
      const skills = await this.listSkills();
      const target = skills.find((s) =>
        s.name === skillName && (!args.pluginId || s.pluginId === args.pluginId) && (!args.rowId || s.rowId === args.rowId),
      );
      if (!target) throw new Error(`DSH skill "${skillName}" is not registered by any active plugin.`);
      const content = await this.getSkill(target.pluginId, target.name, target.rowId);
      if (content === null) throw new Error(`DSH skill "${skillName}" has no readable content.`);
      return content;
    }
    const match = this.chatEntries().find((entry) => entry.tool.server === server && entry.tool.name === tool);
    if (!match) throw new Error(`DSH plugin tool ${server}:${tool} is no longer registered.`);
    const profile = this.state.activeProfileId();
    let result: InvokeResult;
    if (match.kind === 'command') {
      const fallback = Object.keys(args).length ? JSON.stringify(args) : '';
      const input = typeof args.input === 'string' ? args.input : fallback;
      result = await this.invokeCommand(profile, match.pluginId, tool, input, match.rowId);
    } else {
      result = await this.invokeTool(profile, match.pluginId, tool, args, match.rowId);
    }
    if (!result.ok) throw new Error(result.error || `DSH ${match.kind} failed`);
    return result.rendered || JSON.stringify(result.value);
  }

  async contributions(profileId: string, pluginId?: string): Promise<PluginContributions> {
    await this.ensureReady();
    await this.runtimeMutations;
    this.requireActiveProfile(profileId);
    const plugin = pluginId ? this.state.installedByMarketId(profileId, pluginId) : null;
    if (pluginId && !plugin) return { tools: [], commands: [], skills: [] };
    return this.runtime.contributions(plugin?.id);
  }

  private writeProjection(profileId: string): void {
    try {
      const profileDir = this.state.profileDir(profileId);
      fs.mkdirSync(profileDir, { recursive: true });
      const installed = this.state.installed(profileId);
      const dshPlugins = installed.filter((plugin) => plugin.format === 'dsh');
      fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
        name: `dsh-profile-${profileId}`,
        private: true,
        description: 'Projection generated by ConeCode DSH plugin market. Do not edit; source of truth is market-state.json.',
        dependencies: Object.fromEntries(dshPlugins.map((plugin) => [plugin.name, plugin.version])),
        dsh: {
          profile: {
            bundles: dshPlugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.name),
          },
        },
      }, null, 2), 'utf8');
      const patches: Array<Record<string, unknown>> = [];
      for (const plugin of dshPlugins) {
        if (plugin.enabled) for (const override of plugin.bundleOverrides || []) patches.push(override);
        for (const row of plugin.rows) {
          patches.push({
            insert: [{
              id: row.id,
              name: row.name,
              config: row.config,
              ...(row.disabled || !plugin.enabled ? { disabled: true } : {}),
            }],
          });
        }
      }
      fs.writeFileSync(
        path.join(profileDir, 'cordis.patch.yml'),
        `# Generated by ConeCode DSH plugin market. The authoritative state is market-state.json.\n${patches.length ? stringifyYaml(patches) : '[]\n'}`,
        'utf8',
      );
      fs.writeFileSync(path.join(profileDir, 'compatibility.json'), JSON.stringify(this.state.exemptions(profileId), null, 2), 'utf8');
      for (const plugin of dshPlugins) {
        this.installer.linkPlugin(profileId, plugin.name, this.installer.finalDirectory(profileId, pluginDirName(plugin)), `node_modules/${plugin.name}`);
      }
    } catch (error) {
      this.warnings.push(`Profile projection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function pluginDirName(plugin: InstalledPlugin): string {
  return pluginDirectoryName(plugin.name);
}

function backupRecord(plugin: InstalledPlugin, directory: string): BackupRecord {
  const { source, requestedSpec, resolvedSpec, catalogKnown, title } = plugin;
  return {
    version: plugin.version,
    directory,
    createdAt: isoNow(),
    integrity: plugin.integrity,
    installation: { source, requestedSpec, resolvedSpec, catalogKnown, title },
  };
}

function extractScreenshots(readme: string): string[] {
  const out: string[] = [];
  const pattern = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  for (const match of readme.matchAll(pattern)) {
    const url = match[1].replace(/[?#].*$/, '');
    if (/shields\.io|awesome-dsh-plugin\.com\/badge|badge/i.test(url)) continue;
    if (!/\.(png|jpe?g|gif|webp|avif|svg)(?:$|\/)/i.test(url) && !url.includes('raw.githubusercontent.com')) continue;
    if (!out.includes(url)) out.push(url);
    if (out.length >= 6) break;
  }
  return out;
}

function syntheticMarketPlugin(plugin: InstalledPlugin): MarketPlugin {
  return {
    id: plugin.id,
    name: plugin.name,
    format: plugin.format,
    demo: plugin.source?.type === 'bundled-example',
    title: plugin.title,
    description: '',
    category: 'tools',
    labels: [],
    keywords: [],
    declared: {
      engines: (plugin.manifestRaw.engines as Record<string, string>) || {},
      peerDependencies: (plugin.manifestRaw.peerDependencies as Record<string, string>) || {},
      dsh: plugin.dsh,
    },
    versions: [{
      version: plugin.version,
      publishedAt: plugin.updatedAt,
      source: plugin.source || { type: 'npm' },
      engines: {},
      peerDependencies: {},
      dependencies: {},
    }],
    sourceId: 'installed',
  };
}
