import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, Inject } from '@deepseek-ai/cordis';
import {
  type CommandContribution,
  type InvokeResult,
  type PluginContributions,
  type SkillContribution,
  type ToolContribution,
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
  providers: Array<() => any>;
  skillCandidates: Map<string, { provider: any; candidate: any }>;
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
    if (options?.dshHome && options.profileId) await this.mountStorage(options.dshHome, options.profileId);
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

  async load(spec: RuntimePluginSpec): Promise<RuntimePluginState> {
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
    if (spec.format === 'native') return this.loadNative(plugin);

    try {
      const activeRows = spec.rows.filter((row) => !row.disabled);
      if (!activeRows.length) {
        plugin.state = { id: spec.id, status: 'disabled', contributions: emptyContributions() };
        return plugin.state;
      }
      // Resolve dependencies before creating fibers so a bundle can use a
      // private service supplied by an earlier row without borrowing it from
      // another installed plugin.
      const rows = [];
      const shared = new Set<string>([...SUPPORTED_HOST_SERVICES, ...CORDIS_BUILTIN_SERVICES]);
      let bundleScope = this.ensureRoot().extend();
      const privateServices = new Set<string>();
      for (const row of activeRows) {
        const module = await import(pathToFileURL(row.entryPath).href);
        const exported = module.default;
        const entry = typeof exported === 'function' || typeof exported?.apply === 'function' ? exported : module;
        if (typeof entry !== 'function' && typeof entry.apply !== 'function') {
          throw new Error(`${row.name} has no Cordis plugin export`);
        }
        const inject = Object.keys(Inject.resolve(entry.inject));
        for (const name of inject) {
          if (!shared.has(name) && !name.startsWith('storage.backend.')) privateServices.add(name);
        }
        rows.push({ row, entry, inject });
      }
      for (const name of privateServices) bundleScope = bundleScope.isolate(name);
      for (const { row, entry, inject } of rows) {
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
      providers: [],
      skillCandidates: new Map(),
      requiredServices: [],
    };
    const host = {
      name: `conecode-host:${spec.id}:${row.id}:${generation}`,
      apply: (ctx: Context) => {
        const owner = makeFacade(spec, row, rowRuntime);
        ctx.provide('tools', owner.tools);
        ctx.provide('commands', owner.commands);
        ctx.provide('skills', owner.skills);
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
      config: {},
      disabled: false,
    };
    const rowRuntime: RowRuntime = {
      row,
      scope,
      hostFiber: null,
      fiber: null,
      contributions: emptyContributions(spec.id, 'native'),
      providers: [],
      skillCandidates: new Map(),
      requiredServices: [],
    };
    const owner = makeFacade(spec, row, rowRuntime);
    const host = {
      name: `conecode-host:${spec.id}:native:${generation}`,
      apply: (ctx: Context) => {
        ctx.provide('tools', owner.tools);
        ctx.provide('commands', owner.commands);
        ctx.provide('skills', owner.skills);
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
      const dispose = await withTimeout(Promise.resolve(activate(api, {})), 15_000, `activating ${spec.name}`);
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
      try {
        if (row.nativeDispose) await withTimeout(Promise.resolve(row.nativeDispose()), 10_000, 'disposing native plugin');
        if (row.fiber) await withTimeout(Promise.resolve(row.fiber.dispose()), 10_000, 'unloading row');
        if (row.hostFiber) await withTimeout(Promise.resolve(row.hostFiber.dispose()), 10_000, 'disposing row host');
      } catch (error) {
        this.log(`[${plugin.spec.name}] cleanup warning: ${errorText(error)}`, 'warn');
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
    try {
      const state = await this.load(temp);
      const ok = state.status === 'loaded';
      await this.unload(temp.id);
      return { ok, state, ...(ok ? {} : { error: state.error }) };
    } catch (error) {
      await this.unload(temp.id).catch(() => {});
      return { ok: false, state: null, error: errorText(error) };
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
    const row = plugin.rows.find((item) => !rowId || item.row.id === rowId);
    const tool = row?.contributions.tools.find((item) => item.name === name);
    if (!tool) return { ok: false, error: `Tool ${name} is not registered by ${pluginId}`, durationMs: 0 };
    const definition = (row as any).toolDefinitions?.get?.(name);
    const execute = definition?.execute;
    if (typeof execute !== 'function') {
      // definitions live beside the contribution to keep the public shape JSON-safe
      const raw = (row as any).rawTools?.find?.((item: any) => item.name === name);
      if (!raw || typeof raw.execute !== 'function') {
        return { ok: false, error: `Tool ${name} has no execute function`, durationMs: Date.now() - started };
      }
      return runTool(raw, args, started);
    }
    return runTool(definition, args, started);
  }

  async invokeCommand(pluginId: string, rowId: string | null, name: string, rawInput: string): Promise<InvokeResult> {
    const started = Date.now();
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return { ok: false, error: `Plugin ${pluginId} is not loaded`, durationMs: 0 };
    const row = plugin.rows.find((item) => !rowId || item.row.id === rowId);
    const raw = (row as any)?.rawCommands?.find?.((item: any) => item.name === name);
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
        for (const skill of row.contributions.skills) result.push({ ...skill });
        for (const factory of row.providers) {
          try {
            const provider = factory();
            const listed = await withTimeout(Promise.resolve(provider.list()), 20_000, 'listing skills');
            for (const candidate of Array.isArray(listed) ? listed : []) {
              const name = String(candidate?.name || '').trim();
              if (!name) continue;
              row.skillCandidates.set(name, { provider, candidate });
              result.push({
                pluginId: plugin.spec.id,
                rowId: row.row.id,
                name,
                description: String(candidate?.description || ''),
                provider: String(candidate?.provider || provider?.name || ''),
                source: String(candidate?.source || ''),
                hasContent: true,
                candidateId: name,
              });
            }
          } catch (error) {
            this.log(`[${plugin.spec.name}] skills provider failed: ${errorText(error)}`, 'warn');
          }
        }
      }
    }
    const seen = new Set<string>();
    return result.filter((skill) => {
      const key = `${skill.pluginId}\0${skill.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async getSkill(pluginId: string, name: string): Promise<RuntimeSkillContent | null> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return null;
    for (const row of plugin.rows) {
      const direct = (row as any).rawSkills?.find?.((item: any) => item.name === name);
      if (direct) {
        return {
          name: direct.name,
          description: String(direct.description || ''),
          provider: direct.provider,
          content: String(direct.content || readSkillContent(direct) || ''),
          resourceBase: direct.resourceBase,
        };
      }
      const candidate = row.skillCandidates.get(name);
      if (candidate) {
        try {
          const value = await withTimeout(Promise.resolve(candidate.provider.get(candidate.candidate)), 20_000, `loading skill ${name}`);
          return {
            name,
            description: String(value?.description || candidate.candidate?.description || ''),
            provider: String(value?.provider || candidate.provider?.name || ''),
            content: String(value?.content || ''),
            resourceBase: value?.resourceBase,
          };
        } catch (error) {
          this.log(`[${plugin.spec.name}] skill ${name} failed: ${errorText(error)}`, 'warn');
          return null;
        }
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

function makeFacade(spec: RuntimePluginSpec, row: RuntimeRowSpec, runtime: RowRuntime) {
  const toolServer = chatServerName(spec.id, 'tool');
  const commandServer = chatServerName(spec.id, 'command');
  const rawTools: any[] = [];
  const rawCommands: any[] = [];
  const rawSkills: any[] = [];
  (runtime as any).rawTools = rawTools;
  (runtime as any).rawCommands = rawCommands;
  (runtime as any).rawSkills = rawSkills;

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
    registerProvider(factory: () => any) {
      if (typeof factory !== 'function') throw new Error('skills.registerProvider requires a factory');
      runtime.providers.push(factory);
      return () => {
        runtime.providers = runtime.providers.filter((item) => item !== factory);
      };
    },
    async list() {
      const direct = rawSkills.map((item) => ({ ...item }));
      for (const factory of runtime.providers) {
        const provider = factory();
        const listed = await provider?.list?.();
        if (Array.isArray(listed)) direct.push(...listed);
      }
      return direct;
    },
    async get(candidate: any) {
      const direct = rawSkills.find((item) => item.name === candidate?.name);
      if (direct) return direct;
      return candidate;
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
