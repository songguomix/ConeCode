/**
 * Shared contract for the DSH plugin market.
 *
 * The renderer never talks to npm, Cordis or the filesystem directly: every
 * field below crosses the Electron preload bridge. Keep this module free of
 * Node imports so the same types compile on both sides.
 */

/** The exact DSH release this compatibility layer is written against. */
export interface DshBaseline {
  /** Running DSH version used for `engines.dsh` / peer checks. */
  version: string;
  /** Upstream git tag. */
  tag: string;
  /** Full commit SHA of the tag (fixed, not a branch). */
  commit: string;
  /** Repository URL. */
  repository: string;
  /** Documentation and source paths used to derive loader semantics. */
  references: string[];
}

/** Version of ConeCode's own adapter, independent from the DSH baseline. */
export const DSH_COMPAT_LAYER_VERSION = '1.0.0';

export const DSH_BASELINE: DshBaseline = {
  version: '0.2.2-rc.1',
  tag: 'dsh-v0.2.2-rc.1',
  commit: '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db',
  repository: 'https://github.com/deepseek-ai/deepseek-harness',
  references: [
    'docs/architecture.md',
    'docs/user/develop/basic/publish.md',
    'packages/boot/app-boot/README.md',
    'packages/boot/plugin-manager/README.md',
    'packages/boot/app-boot/src/plugin-compatibility.ts',
    'packages/boot/app-boot/src/profile.ts',
    'packages/util/plugin-market-index/README.md',
  ],
};

/** Environment snapshot a verification record is bound to. */
export interface DshRuntimeEnvironment {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion?: string;
  platform: string;
  arch: string;
}

export type CompatibilityState =
  /** Exact plugin version exercised end-to-end on this baseline and layer. */
  | 'verified'
  /** The claimed host part works; listed capabilities are unavailable. */
  | 'partial'
  /** A required version range, platform or host capability is missing. */
  | 'incompatible'
  /** Installs and declares a compatible range, but no recorded execution exists. */
  | 'unverified';

export type MissingCapability =
  | `host-service:${string}`
  | `dsh-version:${string}`
  | `node-version:${string}`
  | `platform:${string}`
  | 'web-client'
  | 'native-binary'
  | 'unsupported-patch-expression';

export interface CompatibilityReason {
  code: string;
  message: string;
  /** Requirement key, e.g. `engines.dsh` or a peer package name. */
  requirement?: string;
  expected?: string;
  actual?: string;
}

export interface CompatibilityResult {
  state: CompatibilityState;
  /** Author-declared range (`engines.dsh`, else DSH peer ranges). */
  authoredRange: string | null;
  authoredKeys: string[];
  /** Requirements the running baseline does not satisfy. */
  requirements: Record<string, string>;
  reasons: CompatibilityReason[];
  /** Host features a plugin declares but this layer cannot provide. */
  missing: MissingCapability[];
  /** Verification record used, if any. */
  verification?: PluginVerification;
  /** True when the user explicitly accepted this exact plugin@baseline pair. */
  exempted: boolean;
}

/** One recorded, reproducible validation run. */
export interface PluginVerification {
  name: string;
  version: string;
  baseline: string;
  baselineCommit: string;
  layerVersion: string;
  environment: DshRuntimeEnvironment;
  state: CompatibilityState;
  /** What was actually executed, not what was statically parsed. */
  verifiedCapabilities: string[];
  missingCapabilities: string[];
  evidence: VerificationEvidence[];
  notes?: string;
  recordedAt: string;
}

export interface VerificationEvidence {
  kind: 'install' | 'load' | 'tool' | 'command' | 'skill' | 'lifecycle' | 'restart' | 'rollback' | 'error-path';
  summary: string;
  /** Sanitized, reproducible observation. Never a secret. */
  observation?: string;
  command?: string;
}

/** Provenance for every number the market displays. */
export interface DataProvenance {
  source: string;
  retrievedAt: string;
  note?: string;
}

export interface MarketStats {
  npmDownloadsLastWeek?: number;
  githubStars?: number;
  provenance: DataProvenance;
}

export type MarketSourceKind = 'npm' | 'git' | 'local' | 'bundled-example';

export interface MarketVersionSource {
  type: MarketSourceKind;
  /** npm package name when different from the plugin name (rare). */
  packageName?: string;
  /** Canonical https git URL. */
  url?: string;
  /** Lowercase 40-hex commit for git sources. */
  commit?: string;
  /** Relative POSIX package directory inside a Git monorepo. */
  subdir?: string;
  /** Absolute path for local sources, resolved by the backend. */
  path?: string;
  /** Registry to ask first, when the catalog pins one. */
  registry?: string;
}

export interface MarketVersion {
  version: string;
  publishedAt: string;
  source: MarketVersionSource;
  engines: { dsh?: string; node?: string };
  peerDependencies: Record<string, string>;
  dependencies: Record<string, string>;
  /** npm `dist.integrity` when the version came from a registry. */
  integrity?: string;
  /** npm tarball URL, retained for provenance only. */
  tarball?: string;
  deprecated?: string;
  size?: number;
  license?: string;
}

export type MarketCategoryId =
  | 'tools'
  | 'skills'
  | 'memory'
  | 'models'
  | 'workflows'
  | 'interface'
  | 'themes'
  | 'integrations'
  | 'native';

export interface MarketCategory {
  id: MarketCategoryId;
  title: { en: string; zh: string };
}

export interface MarketPlugin {
  /** Stable market id; the npm package name for DSH plugins. */
  id: string;
  name: string;
  format: 'dsh' | 'native';
  title: string;
  description: string;
  author?: string;
  homepage?: string;
  repository?: { url: string; directory?: string };
  license?: string;
  icon?: string;
  category: MarketCategoryId;
  labels: string[];
  keywords: string[];
  /** Original `dsh` object from the package manifest (never rewritten). */
  dsh?: Record<string, unknown>;
  /** Original DSH declaration used for compatibility, as published. */
  declared: {
    engines?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    dsh?: Record<string, unknown>;
  };
  versions: MarketVersion[];
  stats?: MarketStats;
  /** Explicitly marks the bundled native sample; never a community claim. */
  demo?: boolean;
  /** Source that contributed this entry. */
  sourceId: string;
  /** Raw manifest of the pinned version when it is bundled. */
  readme?: string;
  screenshots?: string[];
}

export interface MarketCatalog {
  format: 'conecode-dsh-market';
  formatVersion: 1;
  title: string;
  description: string;
  generatedAt: string;
  baseline: DshBaseline;
  categories: MarketCategory[];
  plugins: MarketPlugin[];
}

export interface MarketSource {
  id: string;
  title: string;
  kind: 'bundled' | 'remote' | 'local';
  /** URL or absolute directory. Bundled sources use the built-in catalog. */
  location: string;
  enabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  cachedEntries: number;
  cachePath?: string;
  /** Stale cache was served when the last refresh failed. */
  stale: boolean;
}

export interface MarketProfile {
  id: string;
  name: string;
  createdAt: string;
  active: boolean;
  pluginCount: number;
  enabledCount: number;
  directory: string;
}

export type InstallPhase =
  | 'queued'
  | 'resolving'
  | 'installing'
  | 'probing'
  | 'activating'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'restoring';

export interface InstallOperation {
  requestId: string;
  pluginId: string;
  profileId: string;
  kind: 'install' | 'update' | 'rollback' | 'uninstall' | 'enable' | 'disable' | 'configure';
  phase: InstallPhase;
  message: string;
  startedAt: string;
  finishedAt?: string;
  logTail?: string;
  error?: string;
}

export interface InstalledRow {
  id: string;
  /** Module specifier as written in the bundle patch. */
  name: string;
  entryPath: string;
  config: unknown;
  disabled: boolean;
  inject: string[];
  moduleName?: string;
}

export type InstalledRuntimeStatus =
  | 'loaded'
  | 'disabled'
  | 'load-failed'
  | 'missing-capability'
  | 'restart-required'
  | 'client-only';

export interface InstalledPlugin {
  id: string;
  name: string;
  title: string;
  version: string;
  format: 'dsh' | 'native';
  profileId: string;
  enabled: boolean;
  status: InstalledRuntimeStatus;
  /** Persisted source as requested, before resolution. */
  requestedSpec: string;
  /** Exact resolved spec used for the install. */
  resolvedSpec: string;
  integrity?: string;
  installedAt: string;
  updatedAt: string;
  /** Exact source selected at install time. */
  source?: MarketVersionSource;
  packageDir: string;
  entry: string;
  license?: string;
  repository?: { url: string; directory?: string };
  /** Original package.json, preserved for audit. */
  manifestRaw: Record<string, unknown>;
  dsh?: Record<string, unknown>;
  rows: InstalledRow[];
  /** Module-level Cordis inject names observed at activation. */
  requiredServices?: string[];
  /** Non-insert patch verbs from this bundle, applied over the composed row list. */
  bundleOverrides?: Array<Record<string, unknown>>;
  compatibility: CompatibilityResult;
  contributions: PluginContributions;
  backups: BackupRecord[];
  lastError: string | null;
  /** Set when the live layer was replaced but a full host restart is needed. */
  restartRequired: boolean;
  /** Client halves are detected but not mounted by ConeCode. */
  clientUnsupported: boolean;
  /** False for local/Git imports that are not present in any catalog. */
  catalogKnown?: boolean;
  dataKept: boolean;
}

export interface BackupRecord {
  version: string;
  directory: string;
  createdAt: string;
  integrity?: string;
}

export interface PluginContributions {
  tools: ToolContribution[];
  commands: CommandContribution[];
  skills: SkillContribution[];
}

export interface ToolContribution {
  pluginId: string;
  rowId: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Which chat-facing alias exposes it. */
  chatServer: string;
}

export interface CommandContribution {
  pluginId: string;
  rowId: string;
  name: string;
  description: string;
  inputHint?: string;
  chatServer: string;
}

export interface SkillContribution {
  pluginId: string;
  rowId: string;
  name: string;
  description: string;
  provider?: string;
  source?: string;
  /** Direct registration has content; providers are loaded lazily. */
  hasContent: boolean;
  candidateId?: string;
}

export interface PluginDetail {
  plugin: MarketPlugin;
  version: MarketVersion;
  versions: Array<{
    version: string;
    publishedAt: string;
    compatibility: CompatibilityResult;
    deprecated?: string;
  }>;
  readme: string | null;
  readmeSource: string | null;
  readmeError: string | null;
  screenshots: string[];
  installed: InstalledPlugin | null;
  category: MarketCategory | null;
  verification: PluginVerification | null;
  runtimeNotes: string[];
}

export interface RuntimeInfo {
  available: boolean;
  profileId: string | null;
  workerPid: number | null;
  startedAt: string | null;
  lastError: string | null;
  baseline: DshBaseline;
  layerVersion: string;
  environment: DshRuntimeEnvironment | null;
  supportedServices: string[];
  supportedFormats: string[];
  npmPath: string | null;
  npmVersion: string | null;
  storage: {
    ready: boolean;
    backend: string | null;
    root: string | null;
    error: string | null;
  };
}

export interface CatalogQuery {
  query?: string;
  category?: MarketCategoryId | 'all';
  label?: string;
  sort?: 'relevance' | 'name' | 'updated' | 'downloads' | 'stars';
  page?: number;
  pageSize?: number;
  compatibleOnly?: boolean;
}

export interface CatalogPage {
  items: Array<MarketPlugin & { compatibility: CompatibilityResult; installed: InstalledPlugin | null }>;
  total: number;
  page: number;
  pageSize: number;
  categories: Array<MarketCategory & { count: number }>;
  labels: Array<{ id: string; count: number }>;
  fetchedAt: string;
}

export interface RepositoryInspection {
  input: string;
  url: string;
  ref: string;
  commit: string;
  subdir?: string;
  plugin: MarketPlugin;
  version: MarketVersion;
  compatibility: CompatibilityResult;
  warnings: string[];
}

export interface MarketSnapshot {
  profile: MarketProfile;
  profiles: MarketProfile[];
  catalog: CatalogPage;
  installed: InstalledPlugin[];
  sources: MarketSource[];
  operations: InstallOperation[];
  runtime: RuntimeInfo;
  baseline: DshBaseline;
  layerVersion: string;
  offline: boolean;
  warnings: string[];
}

export interface MarketEvent {
  type: 'operation' | 'installed' | 'runtime' | 'log' | 'sources';
  operation?: InstallOperation;
  pluginId?: string;
  message?: string;
  level?: 'info' | 'warn' | 'error';
}

export interface InvokeResult {
  ok: boolean;
  value?: unknown;
  rendered?: string;
  error?: string;
  durationMs: number;
}

export interface LogsResult {
  path: string;
  text: string;
  truncated: boolean;
}
