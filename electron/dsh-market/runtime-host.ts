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

export interface RuntimeSystemPromptSection {
  pluginId: string;
  rowId: string;
  id: string;
  title?: string;
  content: string;
  priority: number;
}

export interface RuntimeWebServerInfo {
  running: boolean;
  baseUrl: string | null;
  routes: Array<{ pluginId: string; method: string; path: string }>;
}

class HostCapabilityError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`missing host capability: ${missing.join(', ')}`);
    this.name = 'HostCapabilityError';
    this.missing = missing;
  }
}

interface RegisteredPromptEntry {
  id: string;
  title?: string;
  priority: number;
  content?: string;
  render?: (context?: unknown) => string | Promise<string>;
}

interface RegisteredRoute {
  pluginId: string;
  rowId: string;
  method: string;
  path: string;
  prefix: boolean;
  handler: (req: any, res: any) => unknown | Promise<unknown>;
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
  systemPrompts: RegisteredPromptEntry[];
  shellEnvProviders: Array<() => Record<string, string> | Promise<Record<string, string>>>;
  disposers: Array<() => void>;
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

const HOST_PROVIDED_SERVICES = [
  'tools', 'commands', 'skills', 'credentials',
  'systemPrompt', 'sessions', 'shellEnv', 'webServer',
  'fs', 'userApproval', 'scope', 'memory', 'connection', 'agents',
] as const;

export class RuntimeHost {
  private root: Context | null = null;
  private storage: RuntimeStorageInfo = { ready: false, backend: null, root: null, error: null };
  private plugins = new Map<string, PluginRuntime>();
  private logSink: ((message: string, level?: 'info' | 'warn' | 'error') => void) | null = null;
  private generation = 0;
  private llmPlugin: Parameters<Context['plugin']>[0] | null = null;
  private dshHome: string | null = null;
  private profileId: string | null = null;
  private webRoutes: RegisteredRoute[] = [];
  private sessionRecords = new Map<string, { id: string; title?: string; createdAt: string; events: unknown[] }>();
  private sessionListeners = new Set<(event: unknown) => void>();
  private memoryProviders = new Map<string, any>();
  private agentPresets = new Map<string, any>();
  private connectionListeners = new Map<string, Set<(payload: unknown) => void>>();

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
    this.dshHome = options?.dshHome || process.env.DSH_HOME || null;
    this.profileId = options?.profileId || 'default';
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
      const availableInHost = new Set<string>([...HOST_PROVIDED_SERVICES, ...CORDIS_BUILTIN_SERVICES]);
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

  webServerInfo(): RuntimeWebServerInfo {
    return {
      running: this.webRoutes.length > 0,
      baseUrl: this.webRoutes.length > 0 ? 'conecode-dsh://local' : null,
      routes: this.webRoutes.map(({ pluginId, method, path: routePath }) => ({ pluginId, method, path: routePath })),
    };
  }

  private makeExtendedServices(spec: RuntimePluginSpec, row: RuntimeRowSpec, rowRuntime: RowRuntime) {
    const profileDir = this.dshHome && this.profileId
      ? path.join(this.dshHome, 'profiles', this.profileId)
      : spec.packageDir;
    const pluginDataDir = this.dshHome && this.profileId
      ? path.join(this.dshHome, 'profiles', this.profileId, 'data', spec.id.replace(/[^a-zA-Z0-9._-]+/g, '-'))
      : path.join(spec.packageDir, '.data');
    const registerDisposer = (dispose: () => void) => {
      rowRuntime.disposers.push(dispose);
      return dispose;
    };

    const systemPrompt = {
      register: (input: string | { id?: string; title?: string; content?: string; priority?: number; render?: (ctx?: unknown) => string | Promise<string> }) => {
        const entry: RegisteredPromptEntry = typeof input === 'string'
          ? { id: `${spec.id}:${row.id}:${rowRuntime.systemPrompts.length + 1}`, content: input, priority: 100 }
          : {
              id: input?.id || `${spec.id}:${row.id}:${rowRuntime.systemPrompts.length + 1}`,
              title: input?.title,
              content: input?.content,
              render: typeof input?.render === 'function' ? input.render : undefined,
              priority: Number.isFinite(input?.priority) ? Number(input.priority) : 100,
            };
        rowRuntime.systemPrompts.push(entry);
        return registerDisposer(() => {
          const idx = rowRuntime.systemPrompts.indexOf(entry);
          if (idx >= 0) rowRuntime.systemPrompts.splice(idx, 1);
        });
      },
      registerSection(input: any) { return this.register(input); },
      registerProvider(fn: (context?: unknown) => string | Promise<string>) {
        if (typeof fn !== 'function') throw new Error('systemPrompt.registerProvider requires a function');
        return this.register({ render: fn });
      },
      list: () => rowRuntime.systemPrompts.slice(),
      render: async (context?: unknown) => (await this.listSystemPrompts(context)).map((s) => s.content).filter(Boolean).join('\n\n'),
    };

    const sessions = {
      list: () => [...this.sessionRecords.values()],
      get: (id: string) => this.sessionRecords.get(id) || null,
      current: () => {
        const list = [...this.sessionRecords.values()];
        return list.length ? list[list.length - 1] : null;
      },
      create: (meta?: { id?: string; title?: string }) => {
        const id = meta?.id || `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const record = { id, title: meta?.title, createdAt: new Date().toISOString(), events: [] as unknown[] };
        this.sessionRecords.set(id, record);
        return record;
      },
      appendEvent: (id: string, event: unknown) => {
        let record = this.sessionRecords.get(id);
        if (!record) {
          record = { id, createdAt: new Date().toISOString(), events: [] };
          this.sessionRecords.set(id, record);
        }
        record.events.push(event);
        for (const listener of this.sessionListeners) {
          try { listener({ sessionId: id, event }); } catch { /* isolate */ }
        }
      },
      onEvent: (listener: (event: unknown) => void) => {
        this.sessionListeners.add(listener);
        return registerDisposer(() => this.sessionListeners.delete(listener));
      },
    };

    const shellEnv = {
      register: (provider: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)) => {
        const fn = typeof provider === 'function' ? provider : () => ({ ...provider });
        rowRuntime.shellEnvProviders.push(fn);
        return registerDisposer(() => {
          const idx = rowRuntime.shellEnvProviders.indexOf(fn);
          if (idx >= 0) rowRuntime.shellEnvProviders.splice(idx, 1);
        });
      },
      getEnv: () => this.getShellEnv(),
      resolve: async (base: Record<string, string | undefined> = {}) => ({ ...base, ...(await this.getShellEnv()) }),
    };

    const addRoute = (method: string, routePath: string, prefix: boolean, handler: RegisteredRoute['handler']) => {
      const normalized = routePath.startsWith('/') ? routePath : `/${routePath}`;
      const route: RegisteredRoute = {
        pluginId: spec.id,
        rowId: row.id,
        method: (method || '*').toUpperCase(),
        path: normalized,
        prefix,
        handler,
      };
      this.webRoutes.push(route);
      return registerDisposer(() => {
        const idx = this.webRoutes.indexOf(route);
        if (idx >= 0) this.webRoutes.splice(idx, 1);
      });
    };

    const webServer = {
      getBaseUrl: () => Promise.resolve('conecode-dsh://local'),
      registerRoute: (method: string, routePath: string, handler: RegisteredRoute['handler']) => addRoute(method, routePath, false, handler),
      registerPrefix: (prefixPath: string, handler: RegisteredRoute['handler']) => addRoute('*', prefixPath, true, handler),
      get: (routePath: string, handler: RegisteredRoute['handler']) => addRoute('GET', routePath, false, handler),
      post: (routePath: string, handler: RegisteredRoute['handler']) => addRoute('POST', routePath, false, handler),
      put: (routePath: string, handler: RegisteredRoute['handler']) => addRoute('PUT', routePath, false, handler),
      delete: (routePath: string, handler: RegisteredRoute['handler']) => addRoute('DELETE', routePath, false, handler),
      use: (prefixPath: string, handler: RegisteredRoute['handler']) => addRoute('*', prefixPath, true, handler),
      routes: () => this.webRoutes.map(({ pluginId, method, path: routePath }) => ({ pluginId, method, path: routePath })),
    };

    const scopedFs = {
      readFile: (target: string, encoding: BufferEncoding = 'utf8') => fs.promises.readFile(target, encoding),
      writeFile: async (target: string, data: string | Buffer) => {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, data);
      },
      readdir: (target: string) => fs.promises.readdir(target),
      stat: (target: string) => fs.promises.stat(target),
      exists: (target: string) => Promise.resolve(fs.existsSync(target)),
      mkdir: (target: string) => fs.promises.mkdir(target, { recursive: true }),
      rm: (target: string, opts?: fs.RmOptions) => fs.promises.rm(target, opts),
    };

    const userApproval = {
      getPolicy: () => 'auto-safe',
      request: async (req?: { action?: string; danger?: boolean; reason?: string }) => ({
        approved: !req?.danger,
        decision: req?.danger ? 'deny' : 'allow',
        reason: req?.danger ? 'Dangerous operations require explicit user confirmation in ConeCode.' : 'Allowed by ConeCode DSH adapter.',
      }),
    };

    const scope = {
      getDshHome: () => this.dshHome,
      getProfileId: () => this.profileId,
      getProfileDir: () => profileDir,
      getPluginDataDir: (id = spec.id) => {
        const dir = id === spec.id ? pluginDataDir : path.join(profileDir, 'data', id.replace(/[^a-zA-Z0-9._-]+/g, '-'));
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      },
      getPackageDir: () => spec.packageDir,
    };

    const memory = {
      registerProvider: (provider: { name: string; search?: (query: string, opts?: unknown) => unknown; add?: (entry: unknown) => unknown }) => {
        if (!provider?.name) throw new Error('memory.registerProvider requires a provider name');
        const key = `${spec.id}:${row.id}:${provider.name}`;
        this.memoryProviders.set(key, provider);
        return registerDisposer(() => this.memoryProviders.delete(key));
      },
      listProviders: () => [...this.memoryProviders.values()],
      search: async (query: string, opts?: unknown) => {
        const results: unknown[] = [];
        for (const provider of this.memoryProviders.values()) {
          if (typeof provider.search !== 'function') continue;
          const items = await Promise.resolve(provider.search(query, opts));
          if (Array.isArray(items)) results.push(...items);
        }
        return results;
      },
      add: async (entry: unknown) => {
        for (const provider of this.memoryProviders.values()) {
          if (typeof provider.add === 'function') await Promise.resolve(provider.add(entry));
        }
      },
    };

    const connection = {
      isConnected: () => true,
      broadcast: (event: string, payload?: unknown) => {
        const set = this.connectionListeners.get(event);
        if (!set) return;
        for (const fn of set) { try { fn(payload); } catch { /* isolate */ } }
      },
      on: (event: string, listener: (payload: unknown) => void) => {
        let set = this.connectionListeners.get(event);
        if (!set) { set = new Set(); this.connectionListeners.set(event, set); }
        set.add(listener);
        return registerDisposer(() => set!.delete(listener));
      },
    };

    const agents = {
      register: (preset: { name: string; description?: string; [key: string]: unknown }) => {
        if (!preset?.name) throw new Error('agents.register requires a preset name');
        const key = `${spec.id}:${row.id}:${preset.name}`;
        this.agentPresets.set(key, preset);
        return registerDisposer(() => this.agentPresets.delete(key));
      },
      list: () => [...this.agentPresets.values()],
      get: (name: string) => [...this.agentPresets.values()].find((item) => item.name === name) || null,
    };

    return { systemPrompt, sessions, shellEnv, webServer, fs: scopedFs, userApproval, scope, memory, connection, agents };
  }

  private async mountRow(
    spec: RuntimePluginSpec, row: RuntimeRowSpec, bundleScope: Context,
    plugin: Parameters<Context['plugin']>[0], inject: string[],
  ): Promise<RowRuntime> {
    const generation = ++this.generation;
    const label = `${spec.id}:${row.id}:${generation}`;
    let scope = bundleScope;
    for (const serviceName of HOST_PROVIDED_SERVICES) {
      scope = scope.isolate(serviceName, Symbol(`${label}:${serviceName}`));
    }
    scope = scope.extend();
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
      systemPrompts: [],
      shellEnvProviders: [],
      disposers: [],
      requiredServices: [],
    };
    const host = {
      name: `conecode-host:${spec.id}:${row.id}:${generation}`,
      apply: (ctx: Context) => {
        const owner = makeFacade(spec, row, rowRuntime);
        const extended = this.makeExtendedServices(spec, row, rowRuntime);
        ctx.provide('tools', owner.tools);
        ctx.provide('commands', owner.commands);
        ctx.provide('skills', owner.skills);
        ctx.provide('credentials', {
          async resolve(ref: string) {
            const value = process.env[ref];
            return typeof value === 'string' && value ? { value } : undefined;
          },
        });
        ctx.provide('systemPrompt', extended.systemPrompt);
        ctx.provide('sessions', extended.sessions);
        ctx.provide('shellEnv', extended.shellEnv);
        ctx.provide('webServer', extended.webServer);
        ctx.provide('fs', extended.fs);
        ctx.provide('userApproval', extended.userApproval);
        ctx.provide('scope', extended.scope);
        ctx.provide('memory', extended.memory);
        ctx.provide('connection', extended.connection);
        ctx.provide('agents', extended.agents);
        ctx.effect(() => () => {
          for (const item of rowRuntime.providers.values()) item.lifecycle.abort();
          for (const dispose of rowRuntime.disposers.splice(0)) { try { dispose(); } catch { /* ignore */ } }
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
      systemPrompts: [],
      shellEnvProviders: [],
      disposers: [],
      requiredServices: [],
    };
    const owner = makeFacade(spec, row, rowRuntime);
    const extended = this.makeExtendedServices(spec, row, rowRuntime);
    const host = {
      name: `conecode-host:${spec.id}:native:${generation}`,
      apply: (ctx: Context) => {
        ctx.provide('tools', owner.tools);
        ctx.provide('commands', owner.commands);
        ctx.provide('skills', owner.skills);
        ctx.effect(() => () => {
          for (const item of rowRuntime.providers.values()) item.lifecycle.abort();
          for (const dispose of rowRuntime.disposers.splice(0)) { try { dispose(); } catch { /* ignore */ } }
        });
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
        systemPrompt: extended.systemPrompt,
        shellEnv: extended.shellEnv,
        scope: extended.scope,
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
      for (const dispose of row.disposers.splice(0)) { try { dispose(); } catch { /* ignore */ } }
      row.systemPrompts = [];
      row.shellEnvProviders = [];
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

  async listSystemPrompts(context?: unknown): Promise<RuntimeSystemPromptSection[]> {
    const sections: RuntimeSystemPromptSection[] = [];
    for (const plugin of this.plugins.values()) {
      for (const row of plugin.rows) {
        for (const entry of row.systemPrompts) {
          try {
            const content = entry.render
              ? await withTimeout(Promise.resolve(entry.render(context)), 10_000, `systemPrompt ${entry.id}`)
              : entry.content || '';
            if (typeof content === 'string' && content.trim()) {
              sections.push({
                pluginId: plugin.spec.id,
                rowId: row.row.id,
                id: entry.id,
                ...(entry.title ? { title: entry.title } : {}),
                content: content.trim(),
                priority: entry.priority,
              });
            }
          } catch (error) {
            this.log(`[${plugin.spec.name}] systemPrompt ${entry.id} failed: ${errorText(error)}`, 'warn');
          }
        }
      }
    }
    return sections.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  async getShellEnv(): Promise<Record<string, string>> {
    const merged: Record<string, string> = {};
    for (const plugin of this.plugins.values()) {
      for (const row of plugin.rows) {
        for (const provider of row.shellEnvProviders) {
          try {
            const vars = await withTimeout(Promise.resolve(provider()), 10_000, `shellEnv ${plugin.spec.id}`);
            if (vars && typeof vars === 'object') {
              for (const [k, v] of Object.entries(vars)) {
                if (typeof v === 'string') merged[k] = v;
              }
            }
          } catch (error) {
            this.log(`[${plugin.spec.name}] shellEnv provider failed: ${errorText(error)}`, 'warn');
          }
        }
      }
    }
    return merged;
  }

  runtimeInfo(): Array<{ id: string; status: string; rows: number }> {
    return [...this.plugins.values()].map((plugin) => ({ id: plugin.spec.id, status: plugin.state.status, rows: plugin.rows.length }));
  }

  async dispose(): Promise<void> {
    for (const id of [...this.plugins.keys()]) await this.unload(id).catch(() => {});
    this.webRoutes = [];
    this.sessionRecords.clear();
    this.sessionListeners.clear();
    this.memoryProviders.clear();
    this.agentPresets.clear();
    this.connectionListeners.clear();
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
