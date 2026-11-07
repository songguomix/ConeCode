import fs from 'node:fs';
import path from 'node:path';
import type {
  InstalledPlugin,
  InstallOperation,
  MarketSource,
} from '../../src/core/dsh-market/types';
import { assertInside, validateProfileId } from './security';

export interface ProfileState {
  id: string;
  name: string;
  createdAt: string;
  pluginOrder: string[];
  plugins: Record<string, InstalledPlugin>;
  /** Exact plugin@version → exact DSH runtime versions accepted by the user. */
  exemptions: Record<string, string[]>;
}

export interface MarketStateFile {
  format: 'conecode-dsh-market-state';
  formatVersion: 1;
  activeProfile: string;
  profiles: Record<string, ProfileState>;
  sources: MarketSource[];
  operations: Record<string, InstallOperation>;
  updatedAt: string;
}

function now(): string {
  return new Date().toISOString();
}

function defaultProfile(id: string): ProfileState {
  return {
    id,
    name: id === 'default' ? 'Default' : id,
    createdAt: now(),
    pluginOrder: [],
    plugins: {},
    exemptions: {},
  };
}

export class MarketStateStore {
  readonly root: string;
  readonly stateFile: string;
  private state: MarketStateFile;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.stateFile = path.join(this.root, 'market-state.json');
    this.state = this.load();
  }

  private load(): MarketStateFile {
    fs.mkdirSync(this.root, { recursive: true });
    let parsed: Partial<MarketStateFile> | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as MarketStateFile;
    } catch {
      parsed = null;
    }
    const state: MarketStateFile = {
      format: 'conecode-dsh-market-state',
      formatVersion: 1,
      activeProfile: typeof parsed?.activeProfile === 'string' && validateProfileId(parsed.activeProfile) ? parsed.activeProfile : 'default',
      profiles: parsed?.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
      sources: Array.isArray(parsed?.sources) ? parsed.sources : [],
      operations: parsed?.operations && typeof parsed.operations === 'object' ? parsed.operations : {},
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : now(),
    };
    if (!state.profiles.default) state.profiles.default = defaultProfile('default');
    if (!state.profiles[state.activeProfile]) state.activeProfile = 'default';
    for (const profile of Object.values(state.profiles)) {
      if (!Array.isArray(profile.pluginOrder)) profile.pluginOrder = Object.keys(profile.plugins || {});
      if (!profile.plugins || typeof profile.plugins !== 'object') profile.plugins = {};
      if (!profile.exemptions || typeof profile.exemptions !== 'object') profile.exemptions = {};
      for (const pluginId of Object.keys(profile.plugins)) {
        const plugin = profile.plugins[pluginId];
        if (!plugin || plugin.profileId !== profile.id) {
          delete profile.plugins[pluginId];
          profile.pluginOrder = profile.pluginOrder.filter((id) => id !== pluginId);
        }
      }
    }
    const cleanedOps: Record<string, InstallOperation> = {};
    for (const [id, op] of Object.entries(state.operations)) {
      if (!op || typeof op !== 'object') continue;
      if (['queued', 'resolving', 'installing', 'probing', 'activating', 'restoring'].includes(op.phase)) {
        cleanedOps[id] = {
          ...op,
          phase: 'failed',
          message: 'The app quit before this operation finished.',
          error: 'interrupted',
          finishedAt: now(),
        };
      } else {
        cleanedOps[id] = op;
      }
    }
    state.operations = cleanedOps;
    this.state = state;
    return state;
  }

  snapshot(): MarketStateFile {
    return structuredClone(this.state);
  }

  activeProfileId(): string {
    return this.state.activeProfile;
  }

  activeProfile(): ProfileState {
    return this.state.profiles[this.state.activeProfile];
  }

  profile(id = this.state.activeProfile): ProfileState {
    validateProfileId(id);
    const profile = this.state.profiles[id];
    if (!profile) throw new Error(`Unknown profile: ${id}`);
    return profile;
  }

  profiles(): ProfileState[] {
    return Object.values(this.state.profiles).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  createProfile(id: string, name?: string): ProfileState {
    validateProfileId(id);
    if (this.state.profiles[id]) return this.state.profiles[id];
    this.state.profiles[id] = { ...defaultProfile(id), name: name?.trim() || id };
    this.ensureProfileDirs(id);
    this.persist();
    return this.state.profiles[id];
  }

  setActiveProfile(id: string): ProfileState {
    validateProfileId(id);
    if (!this.state.profiles[id]) throw new Error(`Unknown profile: ${id}`);
    this.state.activeProfile = id;
    this.persist();
    return this.state.profiles[id];
  }

  sources(): MarketSource[] {
    return structuredClone(this.state.sources);
  }

  setSources(sources: MarketSource[]): void {
    this.state.sources = structuredClone(sources);
    this.persist();
  }

  upsertSource(source: MarketSource): void {
    const index = this.state.sources.findIndex((item) => item.id === source.id);
    if (index >= 0) this.state.sources[index] = structuredClone(source);
    else this.state.sources.push(structuredClone(source));
    this.persist();
  }

  removeSource(id: string): void {
    this.state.sources = this.state.sources.filter((source) => source.id !== id);
    this.persist();
  }

  updatePlugin(profileId: string, plugin: InstalledPlugin): void {
    const profile = this.profile(profileId);
    if (plugin.profileId !== profileId) throw new Error('Plugin profile mismatch');
    if (!profile.plugins[plugin.id]) profile.pluginOrder.push(plugin.id);
    profile.plugins[plugin.id] = structuredClone(plugin);
    this.persist();
  }

  patchPlugin(profileId: string, pluginId: string, patch: Partial<InstalledPlugin>): InstalledPlugin {
    const profile = this.profile(profileId);
    const current = profile.plugins[pluginId];
    if (!current) throw new Error(`Plugin ${pluginId} is not installed in ${profileId}`);
    const next = { ...current, ...patch, updatedAt: now() };
    profile.plugins[pluginId] = next;
    this.persist();
    return next;
  }

  removePlugin(profileId: string, pluginId: string): InstalledPlugin | null {
    const profile = this.profile(profileId);
    const plugin = profile.plugins[pluginId];
    if (!plugin) return null;
    delete profile.plugins[pluginId];
    profile.pluginOrder = profile.pluginOrder.filter((id) => id !== pluginId);
    this.persist();
    return plugin;
  }

  installed(profileId = this.state.activeProfile): InstalledPlugin[] {
    const profile = this.profile(profileId);
    return profile.pluginOrder.map((id) => profile.plugins[id]).filter(Boolean);
  }

  installedByMarketId(profileId: string, marketId: string): InstalledPlugin | null {
    return this.installed(profileId).find((plugin) => plugin.id === marketId || plugin.name === marketId) || null;
  }

  exemptions(profileId: string): Record<string, string[]> {
    return structuredClone(this.profile(profileId).exemptions);
  }

  exemptionVersions(profileId: string, key: string): string[] {
    return [...(this.profile(profileId).exemptions[key] || [])];
  }

  setExemption(profileId: string, key: string, runtimeVersion: string, enabled: boolean): void {
    const profile = this.profile(profileId);
    const versions = new Set(profile.exemptions[key] || []);
    if (enabled) versions.add(runtimeVersion);
    else versions.delete(runtimeVersion);
    if (versions.size) profile.exemptions[key] = [...versions];
    else delete profile.exemptions[key];
    this.persist();
  }

  recordOperation(operation: InstallOperation): void {
    this.state.operations[operation.requestId] = structuredClone(operation);
    const entries = Object.entries(this.state.operations).sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt));
    while (entries.length > 100) {
      const [id] = entries.shift()!;
      delete this.state.operations[id];
    }
    this.persist();
  }

  operations(profileId?: string): InstallOperation[] {
    return Object.values(this.state.operations)
      .filter((op) => !profileId || op.profileId === profileId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  // ---- filesystem layout -------------------------------------------------

  profileDir(profileId: string): string {
    validateProfileId(profileId);
    return path.join(this.root, 'profiles', profileId);
  }

  pluginsDir(profileId: string): string {
    return path.join(this.profileDir(profileId), 'plugins');
  }

  pluginRoot(profileId: string, dirName: string): string {
    return assertInside(this.pluginsDir(profileId), path.join(this.pluginsDir(profileId), dirName), 'plugin directory');
  }

  backupsDir(profileId: string): string {
    return path.join(this.profileDir(profileId), 'backups');
  }

  stagingDir(profileId: string): string {
    return path.join(this.profileDir(profileId), 'staging');
  }

  logsDir(profileId: string): string {
    return path.join(this.profileDir(profileId), 'logs');
  }

  dataDir(profileId: string): string {
    return path.join(this.profileDir(profileId), 'data');
  }

  runtimeDir(profileId: string): string {
    return path.join(this.profileDir(profileId), '.conecode-runtime');
  }

  cacheDir(): string {
    return path.join(this.root, 'cache');
  }

  ensureProfileDirs(profileId: string): void {
    for (const directory of [
      this.profileDir(profileId),
      this.pluginsDir(profileId),
      this.backupsDir(profileId),
      this.stagingDir(profileId),
      this.logsDir(profileId),
      this.dataDir(profileId),
      path.join(this.profileDir(profileId), 'node_modules'),
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  appendLog(profileId: string, pluginId: string, line: string): string {
    this.ensureProfileDirs(profileId);
    const file = path.join(this.logsDir(profileId), `${pluginId.replace(/[^a-zA-Z0-9._-]+/g, '-')}.log`);
    const stamp = new Date().toISOString();
    fs.appendFileSync(file, `[${stamp}] ${line.replace(/\s+$/g, '')}\n`, 'utf8');
    try {
      const stat = fs.statSync(file);
      if (stat.size > 512 * 1024) {
        const content = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, content.slice(-384 * 1024), 'utf8');
      }
    } catch {
      // logging must never break a lifecycle operation
    }
    return file;
  }

  readLog(profileId: string, pluginId: string): { path: string; text: string; truncated: boolean } {
    const file = path.join(this.logsDir(profileId), `${pluginId.replace(/[^a-zA-Z0-9._-]+/g, '-')}.log`);
    try {
      const content = fs.readFileSync(file, 'utf8');
      return { path: file, text: content.slice(-200_000), truncated: content.length > 200_000 };
    } catch {
      return { path: file, text: '', truncated: false };
    }
  }

  persist(): void {
    const text = JSON.stringify(this.state, null, 2);
    const tmp = `${this.stateFile}.tmp-${process.pid}`;
    this.saveQueue = this.saveQueue.then(() => {
      fs.mkdirSync(this.root, { recursive: true });
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, this.stateFile);
    }).catch(() => {
      // Keep the queue usable; the caller's next write gets another chance.
    });
  }

  async flush(): Promise<void> {
    await this.saveQueue;
  }

  /** Remove staging dirs left by a previous process. */
  cleanupStaging(): string[] {
    const removed: string[] = [];
    for (const profile of this.profiles()) {
      const dir = this.stagingDir(profile.id);
      try {
        for (const entry of fs.readdirSync(dir)) {
          fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
          removed.push(path.join(dir, entry));
        }
      } catch {
        // no staging dir yet
      }
    }
    return removed;
  }
}
