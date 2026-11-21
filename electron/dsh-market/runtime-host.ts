import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, Inject } from '@deepseek-ai/cordis';
import {
  type InvokeResult,
  type PluginContributions,
  type SkillContribution,
} from '../../src/core/dsh-market/types';
import { chatServerName } from '../../src/core/dsh-market/naming';
import { CORDIS_BUILTIN_SERVICES, SUPPORTED_HOST_SERVICES } from './constants';
import { resolvePackageEntry } from './manifest';

const ACTIVE = 2;

export interface RuntimeRowSpec {
  id: string;
  name: string;
  entryPath: string;
  config: unknown;
  disabled: boolean;
  inject?: string[];
}

export interface RuntimePluginSpec {
  id: string;
  name: string;
  title: string;
  format: 'dsh' | 'native';
  packageDir: string;
  nativeEntryPath?: string;
  rows: RuntimeRowSpec[];
  enabled: boolean;
}

export interface RuntimePluginState {
  id: string;
  status: 'loaded' | 'disabled' | 'load-failed' | 'missing-capability';
  error?: string;
  missing?: string[];
  requiredServices?: string[];
  contributions?: PluginContributions;
}

export interface RuntimeSkillContent {
  name: string;
  description: string;
  provider?: string;
  content: string;
  resourceBase?: unknown;
}

class HostCapabilityError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`missing host capability: ${missing.join(', ')}`);
    this.name = 'HostCapabilityError';
    this.missing = missing;
  }
}

interface RowRuntime {
  row: RuntimeRowSpec;
  scope: Context;
  hostFiber: any;
  fiber: any;
  contributions: PluginContributions;
  rawTools: any[];
  rawCommands: any[];
  rawSkills: any[];
  providers: Map<string, { provider: any; lifecycle: AbortController }>;
  nativeDispose?: () => void | Promise<void>;
  requiredServices: string[];
}

interface PluginRuntime {
  spec: RuntimePluginSpec;
  rows: RowRuntime[];
  state: RuntimePluginState;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause && cause !== error ? `${error.message} (cause: ${String(cause)})` : error.message;
  }
  return String(error);
}

function safeJson(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 6) return '[depth limit]';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeJson(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[key] = safeJson(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export interface RuntimeStorageInfo {
  ready: boolean;
  backend: string | null;
  root: string | null;
  error: string | null;
}

export class RuntimeHost {
  private root: Context | null = null;
  private storage: RuntimeStorageInfo = { ready: false, backend: null, root: null, error: null };
  private plugins = new Map<string, PluginRuntime>();
  private logSink: ((message: string, level?: 'info' | 'warn' | 'error') => void) | null = null;
  private generation = 0;
  private llmPlugin: Parameters<Context['plugin']>[0] | null = null;

  get llmReady(): boolean {
    return !!this.llmPlugin;
  }

  setLogSink(sink: (message: string, level?: 'info' | 'warn' | 'error') => void): void {
    this.logSink = sink;
  }

  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.logSink?.(message, level);
  }

  async start(options?: { dshHome?: string; profileId?: string }): Promise<void> {
    if (this.root) return;
    this.root = new Context();
    this.log('Cordis root context created');
    if (options?.dshHome && options.profileId) {
      const profileDir = path.join(options.dshHome, 'profiles', options.profileId);
      const llmDir = path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-llm');
      try {
        const { default: LlmRuntime } = await import(pathToFileURL(resolvePackageEntry(llmDir)).href);
        const registry = this.root.plugin(LlmRuntime);
        await registry;
        if (registry.state !== ACTIVE || !this.root.get('llm')) throw new Error('llm service did not activate');
        this.llmPlugin = LlmRuntime;
      } catch (error) {
        this.log(`LLM registry unavailable: ${errorText(error)}`, 'warn');
      }
      await this.mountStorage(options.dshHome, options.profileId);
    }
  }

  storageInfo(): RuntimeStorageInfo {
    return { ...this.storage };
  }

  /**
   * Mount the official DSH storage stack: @deepseek-ai/dsh-storage (hub),
   * @deepseek-ai/dsh-storage-json (media owner) and
   * @deepseek-ai/dsh-storage-domain (typed KV domains). These are real DSH
   * packages resolved from the profile's pinned runtime, not reimplementations.
   */
  private async mountStorage(dshHome: string, profileId: string): Promise<void> {
    const root = this.ensureRoot();
    const profileDir = path.join(dshHome, 'profiles', profileId);
    const storageRoot = path.join(profileDir, 'storage');
    try {
      const modules = path.join(profileDir, 'node_modules', '@deepseek-ai');
      const storagePkg = path.join(modules, 'dsh-storage');
      const jsonPkg = path.join(modules, 'dsh-storage-json');
      const domainPkg = path.join(modules, 'dsh-storage-domain');
      const importEntry = async (dir: string) => import(pathToFileURL(resolvePackageEntry(dir, '.')).href);
      const storageModule: any = await importEntry(storagePkg);
      const Storage = storageModule.default || storageModule.Storage;
      if (typeof Storage !== 'function') throw new Error('@deepseek-ai/dsh-storage did not export the Storage service');
      const storageFiber = root.plugin(Storage);
      await storageFiber;
      const jsonModule: any = await importEntry(jsonPkg);
      const jsonPlugin = jsonModule.default?.apply ? jsonModule.default : jsonModule;
      const jsonFiber = root.plugin(jsonPlugin, { root: storageRoot });
      await jsonFiber;
      const domainModule: any = await importEntry(domainPkg);
      const domainPlugin = domainModule.default?.apply ? domainModule.default : domainModule;
      const domainFiber = root.plugin(domainPlugin, { backend: 'json' });
      await domainFiber;
      this.storage = { ready: true, backend: 'json', root: storageRoot, error: null };
      this.log(`Storage substrate ready: json backend at ${storageRoot}`);
    } catch (error) {
      this.storage = {
        ready: false,
        backend: null,
        root: storageRoot,
        error: errorText(error),
      };
      this.log(`Storage substrate unavailable: ${this.storage.error}`, 'warn');
    }
  }

  private ensureRoot(): Context {
    if (!this.root) throw new Error('Runtime host is not started');
    return this.root;
  }

  async load(spec: RuntimePluginSpec, parent?: Context): Promise<RuntimePluginState> {
    await this.start();
    const existing = this.plugins.get(spec.id);
    if (existing) await this.unload(spec.id);
    const plugin: PluginRuntime = {
      spec,
      rows: [],
      state: { id: spec.id, status: spec.enabled ? 'load-failed' : 'disabled' },
    };
    this.plugins.set(spec.id, plugin);
    if (!spec.enabled) {
      plugin.state = { id: spec.id, status: 'disabled', contributions: emptyContributions() };
      return plugin.state;
    }
    if (spec.format === 'native') {
      if (spec.rows.find((row) => row.id === 'native')?.disabled) {
        plugin.state = { id: spec.id, status: 'disabled', contributions: emptyContributions() };
        return plugin.state;
      }
      return this.loadNative(plugin);
    }

    try {
      const activeRows = spec.rows.filter((row) => !row.disabled);
      if (!activeRows.length) {
        plugin.state = { id: spec.id, status: spec.rows.length ? 'disabled' : 'loaded', contributions: emptyContributions() };
        return plugin.state;
      }
      // Resolve dependencies before creating fibers so a bundle can use a
      // private service supplied by an earlier row without borrowing it from
      // another installed plugin.
      const rows = [];
      const shared = new Set<string>([...SUPPORTED_HOST_SERVICES, ...CORDIS_BUILTIN_SERVICES]);
      let bundleScope = (parent ?? this.ensureRoot()).extend();
      const privateServices = new Set<string>();
      for (const row of activeRows) {
        const module = await import(pathToFileURL(row.entryPath).href);
        const exported = module.default;
        const entry = typeof exported === 'function' || typeof exported?.apply === 'function' ? exported : module;
        if (typeof entry !== 'function' && typeof entry.apply !== 'function') {
          throw new Error(`${row.name} has no Cordis plugin export`);
        }
        const declared = Inject.resolve(entry.inject);
        const inject = [...new Set([...Object.keys(declared), ...(row.inject ?? [])])];
        for (const name of inject) {
          if (!shared.has(name) && !name.startsWith('storage.backend.')) privateServices.add(name);
        }
        // Cordis also checks the fiber's injection map on each service access.
        // Keep the actual callback/class so config validation and construction
        // retain their original semantics.
        const plugin = row.inject?.length ? {
          name: entry.name,
          Config: entry.Config,
          apply: typeof entry === 'function' ? entry : entry.apply,
          inject: { ...Object.fromEntries(row.inject.map((key) => [key, null])), ...declared },
        } : entry;
        rows.push({ row, entry: plugin, inject });
      }
      for (const name of privateServices) bundleScope = bundleScope.isolate(name);
      const availableInHost = new Set<string>(['tools', 'commands', 'skills', 'credentials', ...CORDIS_BUILTIN_SERVICES]);
      while (rows.length) {
        // A bundle may declare its consumer before the row providing a private service.
        const ready = rows.findIndex(({ inject }) => inject.every((key) => availableInHost.has(key) || bundleScope.get(key) !== undefined));
        if (ready < 0) throw new HostCapabilityError([...new Set(rows.flatMap(({ inject }) => inject.filter((key) =>
          !availableInHost.has(key) && bundleScope.get(key) === undefined)))]);
        const [{ row, entry, inject }] = rows.splice(ready, 1);
        plugin.rows.push(await this.mountRow(spec, row, bundleScope, entry, inject));
      }
    } catch (error) {
      const missing = error instanceof HostCapabilityError ? error.missing : [];
      const requiredServices = [...new Set([...plugin.rows.flatMap((row) => row.requiredServices), ...missing])];
      await this.unloadRows(plugin);
      plugin.state = {
        id: spec.id,
        status: missing.length ? 'missing-capability' : 'load-failed',
        error: errorText(error),
        ...(missing.length ? { missing } : {}),
        contributions: emptyContributions(),
        requiredServices,
      };
      this.log(`[${spec.name}] ${plugin.state.error}`, 'error');
      return plugin.state;
    }
    plugin.state = { id: spec.id, status: 'loaded', contributions: collect(plugin.rows), requiredServices: [...new Set(plugin.rows.flatMap((row) => row.requiredServices))] };
    this.log(`[${spec.name}] loaded ${plugin.rows.length} row(s)`);
    return plugin.state;
  }

  private async mountRow(
    spec: RuntimePluginSpec, row: RuntimeRowSpec, bundleScope: Context,
    plugin: Parameters<Context['plugin']>[0], inject: string[],
  ): Promise<RowRuntime> {
    const generation = ++this.generation;
    const label = `${spec.id}:${row.id}:${generation}`;
    const scope = bundleScope
      .isolate('tools', Symbol(`${label}:tools`))
      .isolate('commands', Symbol(`${label}:commands`))
      .isolate('skills', Symbol(`${label}:skills`))
      .isolate('credentials', Symbol(`${label}:credentials`))
      .extend();
    const rowRuntime: RowRuntime = {
      row,
      scope,
      hostFiber: null,
      fiber: null,
      contributions: emptyContributions(spec.id, row.id),
      rawTools: [],
      rawCommands: [],
      rawSkills: [],
      providers: new Map(),
      requiredServices: [],
    };
    const host = {
      name: `conecode-host:${spec.id}:${row.id}:${generation}`,
      apply: (ctx: Context) => {
        const owner = makeFacade(spec, row, rowRuntime);
        ctx.provide('tools', owner.tools);
        ctx.provide('commands', owner.commands);
        ctx.provide('skills', owner.skills);
        ctx.effect(() => () => { for (const item of rowRuntime.providers.values()) item.lifecycle.abort(); });
        ctx.provide('credentials', {
          async resolve(ref: string) {
            const value = process.env[ref];
            return typeof value === 'string' && value ? { value } : undefined;
          },
        });
      },
    };
    rowRuntime.requiredServices = inject;
    try {
      rowRuntime.hostFiber = scope.plugin(host);
      await rowRuntime.hostFiber;
      const missing = inject.filter((name) => !CORDIS_BUILTIN_SERVICES.some((builtin) => builtin === name) &&
        ((name === 'storage' || name === 'storageDomain' || name.startsWith('storage.backend.')) && !this.storage.ready ||
          scope.get(name) === undefined));
      if (missing.length) throw new HostCapabilityError(missing);

      const fiber = scope.plugin(plugin, row.config ?? {});
      rowRuntime.fiber = fiber;
      await withTimeout(Promise.resolve(fiber), 30_000, `loading ${row.name}`);
      if (fiber.state !== ACTIVE) {
        const absent = Object.keys(Inject.resolve(fiber.inject)).filter((name) => scope.get(name) === undefined);
        if (absent.length) throw new HostCapabilityError(absent);
        throw new Error(`${row.name} stayed in Cordis state ${fiber.state}; an injected service never became available`);
      }
    } catch (error) {
      await rowRuntime.fiber?.dispose().catch(() => {});
      await rowRuntime.hostFiber?.dispose().catch(() => {});
      throw error;
    }
    return rowRuntime;
  }

  private async loadNative(plugin: PluginRuntime): Promise<RuntimePluginState> {
    const root = this.ensureRoot();
    const spec = plugin.spec;
    if (!spec.nativeEntryPath) {
      plugin.state = { id: spec.id, status: 'load-failed', error: 'Native plugin has no entry' };
      return plugin.state;
    }
    const generation = ++this.generation;
    const label = `${spec.id}:native:${generation}`;
    const scope = root
      .isolate('tools', Symbol(`${label}:tools`))
      .isolate('commands', Symbol(`${label}:commands`))
      .isolate('skills', Symbol(`${label}:skills`))
      .extend();
    const row: RuntimeRowSpec = {
      id: 'native',
      name: spec.name,
      entryPath: spec.nativeEntryPath,
      config: spec.rows.find((item) => item.id === 'native')?.config ?? {},
      disabled: false,
    };
    const rowRuntime: RowRuntime = {
      row,
      scope,
      hostFiber: null,
      fiber: null,
      contributions: emptyContributions(spec.id, 'native'),
      rawTools: [],
      rawCommands: [],
      rawSkills: [],
      providers: new Map(),
      requiredServices: [],
    };
    const owner = makeFacade(spec, row, rowRuntime);
    const host = {
      name: `conecode-host:${spec.id}:native:${generation}`,
      apply: (ctx: Context) => {
        ctx.provide('tools', owner.tools);
        ctx.provide('commands', owner.commands);
        ctx.provide('skills', owner.skills);
        ctx.effect(() => () => { for (const item of rowRuntime.providers.values()) item.lifecycle.abort(); });
      },
    };
    rowRuntime.hostFiber = scope.plugin(host);
    await rowRuntime.hostFiber;
    try {
      const module = await import(pathToFileURL(spec.nativeEntryPath).href);
      const activate = module.activate || module.default?.activate || (typeof module.default === 'function' ? module.default : null);
      if (typeof activate !== 'function') throw new Error('Native plugin must export activate(api, config)');
      const api = {
        tools: owner.tools,
        commands: owner.commands,
        skills: owner.skills,
        logger: console,
        plugin: { id: spec.id, name: spec.name },
      };
      const dispose = await withTimeout(Promise.resolve(activate(api, row.config)), 15_000, `activating ${spec.name}`);
      if (typeof dispose === 'function') rowRuntime.nativeDispose = dispose;
      plugin.rows.push(rowRuntime);
      plugin.state = { id: spec.id, status: 'loaded', contributions: collect(plugin.rows), requiredServices: [...new Set(plugin.rows.flatMap((row) => row.requiredServices))] };
      this.log(`[${spec.name}] native plugin loaded`);
      return plugin.state;
    } catch (error) {
      plugin.state = {
        id: spec.id,
        status: 'load-failed',
        error: errorText(error),
        contributions: emptyContributions(),
      };
      this.log(`[${spec.name}] ${plugin.state.error}`, 'error');
      await rowRuntime.hostFiber?.dispose().catch(() => {});
      return plugin.state;
    }
  }

  private async unloadRows(plugin: PluginRuntime): Promise<void> {
    for (const row of plugin.rows.reverse()) {
      for (const [label, dispose] of [
        ['disposing native plugin', () => row.nativeDispose?.()],
        ['unloading row', () => row.fiber?.dispose()],
        ['disposing row host', () => row.hostFiber?.dispose()],
      ] as const) {
        try {
          const task = dispose();
          if (task !== undefined) await withTimeout(Promise.resolve(task), 10_000, label);
        } catch (error) {
          this.log(`[${plugin.spec.name}] cleanup warning: ${errorText(error)}`, 'warn');
        }
      }
      row.contributions = emptyContributions();
    }
    plugin.rows = [];
  }

  async unload(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;
    await this.unloadRows(plugin);
    this.plugins.delete(pluginId);
    this.log(`[${plugin.spec.name}] unloaded`);
  }

  async reload(spec: RuntimePluginSpec): Promise<RuntimePluginState> {
    await this.unload(spec.id);
    return this.load(spec);
  }

  async probe(spec: RuntimePluginSpec): Promise<{ ok: boolean; state: RuntimePluginState | null; error?: string }> {
    const temp = { ...spec, id: `__probe__:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, enabled: true };
    let registry: ReturnType<Context['plugin']> | undefined;
    try {
      let scope: Context | undefined;
      if (this.llmPlugin && spec.format === 'dsh') {
        scope = this.ensureRoot().isolate('llm');
        registry = scope.plugin(this.llmPlugin);
        await registry;
      }
      const state = await this.load(temp, scope);
      const ok = state.status === 'loaded' || state.status === 'disabled';
      await this.unload(temp.id);
      return { ok, state, ...(ok ? {} : { error: state.error }) };
    } catch (error) {
      await this.unload(temp.id).catch(() => {});
      return { ok: false, state: null, error: errorText(error) };
    } finally {
      await registry?.dispose();
    }
  }

  contributions(pluginId?: string): PluginContributions {
    const plugins = pluginId ? [this.plugins.get(pluginId)].filter(Boolean) as PluginRuntime[] : [...this.plugins.values()];
    return collect(plugins.flatMap((plugin) => plugin.rows));
  }

  async invokeTool(pluginId: string, rowId: string | null, name: string, args: unknown): Promise<InvokeResult> {
    const started = Date.now();
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return { ok: false, error: `Plugin ${pluginId} is not loaded`, durationMs: 0 };
    const definition = plugin.rows.filter((item) => !rowId || item.row.id === rowId)
      .flatMap((row) => row.rawTools).find((tool) => tool.name === name);
    if (!definition) return { ok: false, error: `Tool ${name} is not registered by ${pluginId}`, durationMs: 0 };
    return runTool(definition, args, started);
  }

  async invokeCommand(pluginId: string, rowId: string | null, name: string, rawInput: string): Promise<InvokeResult> {
    const started = Date.now();
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return { ok: false, error: `Plugin ${pluginId} is not loaded`, durationMs: 0 };
    const raw = plugin.rows.filter((item) => !rowId || item.row.id === rowId)
      .flatMap((row) => row.rawCommands).find((command) => command.name === name);
    if (!raw || typeof raw.handler !== 'function') {
      return { ok: false, error: `Command ${name} is not registered by ${pluginId}`, durationMs: 0 };
    }
    try {
      const value = await withTimeout(Promise.resolve(raw.handler({ rawInput })), 60_000, `command ${name}`);
      return {
        ok: true,
        value: safeJson(value),
        rendered: typeof value === 'string' ? value : JSON.stringify(safeJson(value), null, 2),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return { ok: false, error: errorText(error), durationMs: Date.now() - started };
    }
  }

  async listSkills(): Promise<SkillContribution[]> {
    const result: SkillContribution[] = [];
    for (const plugin of this.plugins.values()) {
      for (const row of plugin.rows) {
        const candidates = await discoverSkills(row, {}, (error) => this.log(`[${plugin.spec.name}] skills provider failed: ${errorText(error)}`, 'warn'));
        for (const { candidate, provider } of candidates.values()) {
          result.push({
            pluginId: plugin.spec.id, rowId: row.row.id, name: candidate.name,
            description: String(candidate.description || ''), provider: candidate.provider || provider?.name,
            source: candidate.source, hasContent: !!provider || typeof candidate.content === 'string' || !!candidate.locator,
            ...(provider ? { candidateId: candidate.name } : {}),
          });
        }
      }
    }
    return result;
  }

  async getSkill(pluginId: string, name: string, rowId?: string): Promise<RuntimeSkillContent | null> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return null;
    for (const row of plugin.rows) {
      if (rowId !== undefined && row.row.id !== rowId) continue;
      try {
        const found = await getRowSkill(row, name, {}, (error) => this.log(`[${plugin.spec.name}] skills provider failed: ${errorText(error)}`, 'warn'));
        if (found) return {
          name, description: String(found.description || ''), provider: found.provider,
          content: String(found.content ?? readSkillContent(found) ?? ''), resourceBase: found.resourceBase,
        };
      } catch (error) {
        this.log(`[${plugin.spec.name}] skill ${name} failed: ${errorText(error)}`, 'warn');
      }
    }
    return null;
  }

  runtimeInfo(): Array<{ id: string; status: string; rows: number }> {
    return [...this.plugins.values()].map((plugin) => ({ id: plugin.spec.id, status: plugin.state.status, rows: plugin.rows.length }));
  }

  async dispose(): Promise<void> {
    for (const id of [...this.plugins.keys()]) await this.unload(id).catch(() => {});
    if (this.root) await this.root.fiber.dispose().catch(() => {});
    this.root = null;
    this.llmPlugin = null;
    this.storage = { ready: false, backend: null, root: null, error: null };
  }
}

function emptyContributions(pluginId = '', rowId = ''): PluginContributions {
  void pluginId;
  void rowId;
  return { tools: [], commands: [], skills: [] };
}

function collect(rows: RowRuntime[]): PluginContributions {
  return {
    tools: rows.flatMap((row) => row.contributions.tools),
    commands: rows.flatMap((row) => row.contributions.commands),
    skills: rows.flatMap((row) => row.contributions.skills),
  };
}

function readSkillContent(spec: any): string | undefined {
  if (typeof spec?.content === 'string') return spec.content;
  if (spec?.locator?.href) {
    try {
      // Locators are file URLs from well-behaved providers.
      return String(fs.readFileSync(new URL(spec.locator), 'utf8'));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function discoverSkills(row: RowRuntime, options: object, warn?: (error: unknown) => void) {
  const found = new Map<string, { candidate: any; provider?: any; rank: number }>();
  for (const candidate of row.rawSkills) {
    if (!found.has(candidate.name)) found.set(candidate.name, { candidate, rank: 250 });
  }
  for (const { provider, lifecycle } of row.providers.values()) {
    try {
      const observed = await withTimeout(Promise.resolve(provider.list(options)), 20_000, 'listing skills');
      const candidates = Array.isArray(observed) ? observed : observed?.candidates;
      if (!Array.isArray(candidates) || lifecycle.signal.aborted) continue;
      for (const candidate of candidates) {
        if (typeof candidate?.name !== 'string' || !candidate.name) continue;
        const rank = Number.isFinite(candidate.rank) ? candidate.rank : Infinity;
        const previous = found.get(candidate.name);
        if (!previous || rank < previous.rank) found.set(candidate.name, { candidate, provider, rank });
      }
    } catch (error) {
      warn?.(error);
    }
  }
  return found;
}

async function getRowSkill(row: RowRuntime, name: string, options: object, warn?: (error: unknown) => void) {
  const match = (await discoverSkills(row, options, warn)).get(name);
  if (!match?.provider) return match?.candidate;
  return withTimeout(Promise.resolve(match.provider.get(match.candidate, options)), 20_000, `loading skill ${name}`);
}

function makeFacade(spec: RuntimePluginSpec, row: RuntimeRowSpec, runtime: RowRuntime) {
  const toolServer = chatServerName(spec.id, 'tool');
  const commandServer = chatServerName(spec.id, 'command');
  const { rawTools, rawCommands, rawSkills } = runtime;

  const tools = {
    register(definition: any) {
      if (!definition || typeof definition.name !== 'string' || !definition.name) throw new Error('tools.register requires a name');
      if (typeof definition.execute !== 'function') throw new Error(`tool ${definition.name} has no execute()`);
      rawTools.push(definition);
      runtime.contributions.tools.push({
        pluginId: spec.id,
        rowId: row.id,
        name: definition.name,
        description: String(definition.description || ''),
        parameters: safeJson(definition.parameters || { type: 'object', properties: {} }) as Record<string, unknown>,
        chatServer: toolServer,
      });
      return () => {
        const index = rawTools.indexOf(definition);
        if (index >= 0) rawTools.splice(index, 1);
        runtime.contributions.tools = runtime.contributions.tools.filter((item) => item.name !== definition.name);
      };
    },
    list() {
      return rawTools.slice();
    },
  };

  const commands = {
    register(definition: any) {
      if (!definition || typeof definition.name !== 'string' || !definition.name) throw new Error('commands.register requires a name');
      if (typeof definition.handler !== 'function') throw new Error(`command ${definition.name} has no handler()`);
      rawCommands.push(definition);
      runtime.contributions.commands.push({
        pluginId: spec.id,
        rowId: row.id,
        name: definition.name,
        description: String(definition.description || ''),
        inputHint: typeof definition.input?.hint === 'string' ? definition.input.hint : undefined,
        chatServer: commandServer,
      });
      return () => {
        const index = rawCommands.indexOf(definition);
        if (index >= 0) rawCommands.splice(index, 1);
        runtime.contributions.commands = runtime.contributions.commands.filter((item) => item.name !== definition.name);
      };
    },
    list() {
      return rawCommands.slice();
    },
  };

  const skills = {
    register(definition: any) {
      if (!definition || typeof definition.name !== 'string' || !definition.name) throw new Error('skills.register requires a name');
      rawSkills.push(definition);
      runtime.contributions.skills.push({
        pluginId: spec.id,
        rowId: row.id,
        name: definition.name,
        description: String(definition.description || ''),
        provider: typeof definition.provider === 'string' ? definition.provider : undefined,
        source: typeof definition.source === 'string' ? definition.source : undefined,
        hasContent: typeof definition.content === 'string' || !!definition.locator,
      });
      return () => {
        const index = rawSkills.indexOf(definition);
        if (index >= 0) rawSkills.splice(index, 1);
        runtime.contributions.skills = runtime.contributions.skills.filter((item) => item.name !== definition.name);
      };
    },
    registerProvider(factory: (control: { signal: AbortSignal; invalidate: () => void }) => any) {
      if (typeof factory !== 'function') throw new Error('skills.registerProvider requires a factory');
      const lifecycle = new AbortController();
      try {
        // Every lookup observes a fresh catalog, including after invalidate().
        const provider = factory({ signal: lifecycle.signal, invalidate() {} });
        if (!provider?.name || typeof provider.list !== 'function' || typeof provider.get !== 'function') {
          throw new Error('A skill provider must have a name, list() and get()');
        }
        if (runtime.providers.has(provider.name)) throw new Error(`Duplicate skill provider: ${provider.name}`);
        runtime.providers.set(provider.name, { provider, lifecycle });
        return () => {
          if (runtime.providers.get(provider.name)?.provider === provider) runtime.providers.delete(provider.name);
          lifecycle.abort();
        };
      } catch (error) {
        lifecycle.abort();
        throw error;
      }
    },
    async list(options = {}) {
      return [...(await discoverSkills(runtime, options)).values()].map(({ candidate }) => candidate);
    },
    async get(name: string, options = {}) {
      return getRowSkill(runtime, name, options);
    },
  };

  return { tools, commands, skills };
}

async function runTool(definition: any, args: unknown, started: number): Promise<InvokeResult> {
  const controller = new AbortController();
  const timeout = Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0
    ? Math.min(120_000, definition.timeoutMs)
    : 60_000;
  const exec = {
    signal: controller.signal,
    callId: `conecode-${Date.now()}`,
  };
  try {
    const value = await withTimeout(Promise.resolve(definition.execute(args ?? {}, exec)), timeout, `tool ${definition.name}`);
    let rendered: string | undefined;
    try {
      if (typeof definition.output?.render === 'function') {
        const content = await definition.output.render(args ?? {}, value);
        if (Array.isArray(content)) {
          rendered = content.map((item) => typeof item?.text === 'string' ? item.text : '').filter(Boolean).join('\n');
        } else if (typeof content === 'string') {
          rendered = content;
        }
      }
    } catch {
      // Rendering is presentation-only; the canonical value is still evidence.
    }
    if (!rendered) rendered = typeof value === 'string' ? value : JSON.stringify(safeJson(value), null, 2);
    return { ok: true, value: safeJson(value), rendered, durationMs: Date.now() - started };
  } catch (error) {
    controller.abort();
    return { ok: false, error: errorText(error), durationMs: Date.now() - started };
  }
}
