import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  InvokeResult,
  MarketEvent,
  PluginContributions,
  SkillContribution,
} from '../../src/core/dsh-market/types';
import type {
  RuntimePluginSpec,
  RuntimePluginState,
  RuntimeSkillContent,
} from './runtime-host';

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class DshRuntimeManager {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private profileId: string | null = null;
  private dshHome: string | null = null;
  private startedAt: string | null = null;
  private lastError: string | null = null;
  private eventSink: ((event: MarketEvent) => void) | null = null;
  private workerPath: string | null = null;
  private storageInfo: { ready: boolean; backend: string | null; root: string | null; error: string | null } = { ready: false, backend: null, root: null, error: null };

  onEvent(sink: (event: MarketEvent) => void): void {
    this.eventSink = sink;
  }

  private emit(event: MarketEvent): void {
    this.eventSink?.(event);
  }

  private locateWorker(): string {
    if (this.workerPath) return this.workerPath;
    const candidates = [
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'dist-electron', 'dsh-worker.js'),
      path.join(__dirname, 'dsh-worker.js'),
      path.join(__dirname, 'dsh-worker.cjs'),
      path.join(process.cwd(), 'dist-electron', 'dsh-worker.js'),
      path.join(process.cwd(), 'dist-electron', 'dsh-worker.cjs'),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
      throw new Error(`DSH runtime worker is missing. Run "npm run build" or "npm run dev" again (looked for dsh-worker.js beside ${__dirname}).`);
    }
    this.workerPath = found;
    return found;
  }

  getInfo(): { available: boolean; profileId: string | null; startedAt: string | null; lastError: string | null; threadId: number | null; storage: { ready: boolean; backend: string | null; root: string | null; error: string | null } } {
    return {
      available: !!this.worker,
      profileId: this.profileId,
      startedAt: this.startedAt,
      lastError: this.lastError,
      threadId: this.worker?.threadId ?? null,
      storage: this.storageInfo,
    };
  }

  async ensureStarted(profileId: string, dshHome: string, requireStorage = false): Promise<void> {
    if (this.worker && this.profileId === profileId && this.dshHome === dshHome) {
      if (!requireStorage || this.storageInfo.ready) return;
      await this.shutdown();
    }
    if (this.worker) await this.shutdown();
    const workerPath = this.locateWorker();
    const worker = new Worker(workerPath, {
      env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
      name: `conecode-dsh-runtime:${profileId}`,
    });
    this.worker = worker;
    this.profileId = profileId;
    this.dshHome = dshHome;
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    worker.on('message', (message: any) => {
      if (message?.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else {
          const error = new Error(message.error?.message || 'Runtime request failed');
          (error as any).stack = message.error?.stack || error.stack;
          (error as any).missing = message.error?.missing;
          pending.reject(error);
        }
        return;
      }
      if (message?.event === 'log') {
        this.emit({ type: 'log', message: String(message.message || ''), level: message.level || 'info' });
        return;
      }
      if (message?.event === 'fatal') {
        this.lastError = message.error?.message || 'DSH runtime worker crashed';
        this.emit({ type: 'runtime', message: this.lastError || 'DSH runtime worker crashed', level: 'error' });
      }
    });
    worker.on('error', (error: Error) => {
      this.lastError = error.message;
      this.failAll(error);
      this.emit({ type: 'runtime', message: error.message, level: 'error' });
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.worker = null;
        this.startedAt = null;
      }
      const message = code === 0 ? 'DSH runtime worker exited' : `DSH runtime worker exited with code ${code}`;
      this.lastError = code === 0 ? this.lastError : message;
      this.failAll(new Error(message));
    });
    const initialized = await this.request('init', { dshHome, profileId }, 30_000);
    this.storageInfo = initialized?.storage || { ready: false, backend: null, root: null, error: 'Storage stack unavailable' };
  }

  private request(type: string, payload: unknown, timeoutMs = 120_000): Promise<any> {
    if (!this.worker) return Promise.reject(new Error('DSH runtime worker is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH runtime request "${type}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ id, type, payload });
    });
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async load(spec: RuntimePluginSpec): Promise<RuntimePluginState> {
    return this.request('load', { spec }, 120_000);
  }

  async unload(pluginId: string): Promise<void> {
    await this.request('unload', { pluginId }, 60_000);
  }

  async reload(spec: RuntimePluginSpec): Promise<RuntimePluginState> {
    return this.request('reload', { spec }, 120_000);
  }

  async probe(spec: RuntimePluginSpec): Promise<{ ok: boolean; state: RuntimePluginState | null; error?: string }> {
    return this.request('probe', { spec }, 120_000);
  }

  async contributions(pluginId?: string): Promise<PluginContributions> {
    return this.request('contributions', { pluginId }, 30_000);
  }

  async listSkills(): Promise<SkillContribution[]> {
    return this.request('listSkills', {}, 60_000);
  }

  async getSkill(pluginId: string, name: string): Promise<RuntimeSkillContent | null> {
    return this.request('getSkill', { pluginId, name }, 30_000);
  }

  async invokeTool(pluginId: string, rowId: string | null, name: string, args: unknown): Promise<InvokeResult> {
    return this.request('invokeTool', { pluginId, rowId, name, args }, 180_000);
  }

  async invokeCommand(pluginId: string, rowId: string | null, name: string, rawInput: string): Promise<InvokeResult> {
    return this.request('invokeCommand', { pluginId, rowId, name, rawInput }, 180_000);
  }

  async shutdown(): Promise<void> {
    if (!this.worker) return;
    try {
      await this.request('shutdown', {}, 10_000);
    } catch {
      // A dead worker cannot answer; terminate below.
    }
    const worker = this.worker;
    this.worker = null;
    this.profileId = null;
    this.startedAt = null;
    this.failAll(new Error('DSH runtime worker shut down'));
    await worker.terminate().catch(() => {});
  }
}
