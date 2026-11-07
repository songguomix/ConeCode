import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { newId } from '../protocol/ids.js';
import { CuaError, isCuaError } from '../protocol/errors.js';
import { actionSignature } from '../protocol/observation-utils.js';
import {
  ActionSchema,
  AuthorizationScopeSchema,
  BudgetSchema,
  CreateTaskInputSchema,
  DEFAULT_BUDGET,
  EnvironmentSchema,
  SessionSchema,
  TaskSchema,
  UserInputSchema,
  isTerminal,
  nowIso,
  type CreateTaskInput,
  type Observation,
  type Session,
  type Task,
  type TaskSummary,
  type UserInput,
} from '../protocol/schemas.js';
import { assertTransition } from '../protocol/transitions.js';
import { SessionStore } from '../store/store.js';
import { ArtifactStore } from '../store/artifacts.js';
import { BrowserDriver } from '../drivers/browser/browser-driver.js';
import { MacDesktopDriver } from '../drivers/desktop/macos-driver.js';
import type { Driver } from '../drivers/types.js';
import { OpenAICompatibleAdapter } from '../model/openai-compat.js';
import { ScriptedAdapter, type ScriptStep } from '../model/scripted.js';
import { Planner } from '../agent/planner.js';
import { Executor } from '../agent/executor.js';
import { Verifier } from '../agent/verifier.js';
import { TaskController } from '../agent/task-controller.js';
import { Monitor } from '../agent/monitor.js';
import { WorkflowMemory } from '../agent/workflow-memory.js';
import { BudgetTracker, CancellationToken } from '../runtime/control.js';

export interface RuntimeServiceConfig {
  dataDir?: string;
  artifactsDir?: string;
  dbPath?: string;
  maxConcurrency?: number;
  recoverOnStart?: boolean;
  headless?: boolean;
  helperPath?: string;
  sendScreenshots?: boolean;
  monitorIntervalMs?: number;
  workflowMaxAgeMs?: number;
  observationMode?: 'projected' | 'full';
  defaultModel?: {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKeyEnv?: string;
  };
}

export interface TaskDetails {
  task: Task;
  session?: Session;
  latestObservation?: Observation;
  actions: ReturnType<SessionStore['listActions']>;
  verifications: ReturnType<SessionStore['listVerifications']>;
  events: ReturnType<SessionStore['listEvents']>;
  controller?: ReturnType<TaskController['snapshot']>;
}

export interface Metrics {
  sampleSize: number;
  succeeded: number;
  failed: number;
  needsAttention: number;
  cancelled: number;
  inProgress: number;
  successRate: number | null;
  falseCompletionRate: number | null;
  recoveryCount: number;
  recoverySuccessCount: number;
  duplicateActionIntents: number;
  modelCalls: number;
  codeRuns: number;
  actionCount: number;
  averageDurationMs: number | null;
  note: string;
}

interface ActiveRun {
  controller: TaskController;
  driver: Driver;
  session: Session;
  ownerId: string;
  leaseFencing: number;
  resources: string[];
  done: Promise<void>;
}

/**
 * Owns the database, scheduler and live controllers. In a single process the
 * scheduler provides per-session and per-business-object serialization. The
 * database lease is the persistence/fencing hook for a future multi-worker
 * deployment; it is already acquired and released here.
 */
export class RuntimeService extends EventEmitter {
  readonly store: SessionStore;
  readonly artifacts: ArtifactStore;
  readonly config: Required<Pick<RuntimeServiceConfig, 'dataDir' | 'artifactsDir' | 'maxConcurrency' | 'recoverOnStart' | 'headless' | 'sendScreenshots'>> &
    RuntimeServiceConfig;
  private readonly verifier = new Verifier();
  private readonly monitor: Monitor;
  private readonly workflows: WorkflowMemory;
  private readonly active = new Map<string, ActiveRun>();
  private readonly queue: string[] = [];
  private readonly busyResources = new Set<string>();
  private readonly scripts = new Map<string, ScriptStep[]>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly ownerId = `worker_${process.pid}_${newId('run').slice(-8)}`;
  private monitorTimer?: NodeJS.Timeout;
  private started = false;

  constructor(config: RuntimeServiceConfig = {}) {
    super();
    const workflowMaxAgeMs = config.workflowMaxAgeMs ?? Number(process.env.CUA_WORKFLOW_MAX_AGE_MS ?? 7 * 24 * 60 * 60_000);
    if (!Number.isSafeInteger(workflowMaxAgeMs) || workflowMaxAgeMs < 0) {
      throw new CuaError('PROTOCOL_INVALID', 'workflowMaxAgeMs / CUA_WORKFLOW_MAX_AGE_MS must be a non-negative safe integer.');
    }
    if (config.observationMode !== undefined && !['full', 'projected'].includes(config.observationMode)) {
      throw new CuaError('PROTOCOL_INVALID', 'observationMode must be full or projected.');
    }
    const dataDir = resolve(config.dataDir ?? process.env.CUA_DATA_DIR ?? join(process.cwd(), '.cua'));
    this.config = {
      ...config,
      dataDir,
      artifactsDir: resolve(config.artifactsDir ?? join(dataDir, 'artifacts')),
      dbPath: config.dbPath ?? join(dataDir, 'runtime.db'),
      maxConcurrency: config.maxConcurrency ?? 2,
      recoverOnStart: config.recoverOnStart ?? true,
      headless: config.headless ?? true,
      sendScreenshots: config.sendScreenshots ?? process.env.CUA_SEND_SCREENSHOTS === '1',
      helperPath: config.helperPath,
      workflowMaxAgeMs,
      observationMode: config.observationMode ?? 'projected',
    };
    this.store = new SessionStore(this.config.dbPath);
    this.artifacts = new ArtifactStore(this.config.artifactsDir, this.store);
    this.monitor = new Monitor(this.store);
    this.workflows = new WorkflowMemory(this.store, { maxAgeMs: workflowMaxAgeMs });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.config.artifactsDir, { recursive: true });
    this.started = true;
    if (this.config.recoverOnStart) {
      await this.recoverAll();
    }
    const interval = this.config.monitorIntervalMs ?? 30_000;
    if (interval > 0) {
      this.monitorTimer = setInterval(() => {
        try {
          this.monitor.check();
        } catch {
          // A monitor error must not take down task execution.
        }
      }, interval);
      this.monitorTimer.unref?.();
    }
  }

  async createTask(raw: unknown): Promise<TaskSummary> {
    const input = CreateTaskInputSchema.parse(raw);
    const environment = EnvironmentSchema.parse(input.environment);
    const authorization = AuthorizationScopeSchema.parse(input.authorization ?? {});
    if (environment.kind === 'browser' && environment.startUrl) {
      const origin = new URL(environment.startUrl).origin;
      if (authorization.allowedOrigins.length === 0) {
        authorization.allowedOrigins = [origin];
      } else if (
        !authorization.allowedOrigins.some((entry) => {
          if (entry === '*') return true;
          try {
            return new URL(entry).origin === origin;
          } catch {
            return entry === origin;
          }
        })
      ) {
        throw new CuaError('AUTHORIZATION_DENIED', `startUrl ${environment.startUrl} is outside allowedOrigins.`);
      }
    }
    if (environment.kind === 'desktop' && !authorization.allowDesktop) {
      throw new CuaError('AUTHORIZATION_DENIED', 'Desktop environment requires authorization.allowDesktop=true.');
    }

    const budgets = BudgetSchema.parse({ ...DEFAULT_BUDGET, ...(input.budgets ?? {}) });
    const taskId = newId('task');
    const runId = newId('run');
    const sessionId = newId('ses');
    const createdAt = nowIso();
    const task: Task = TaskSchema.parse({
      schemaVersion: 1,
      id: taskId,
      runId,
      goal: input.goal,
      constraints: input.constraints,
      acceptance: input.acceptance,
      acceptanceSource: input.acceptanceSource,
      authorization,
      budgets,
      environment,
      status: 'created',
      createdAt,
      updatedAt: createdAt,
      version: 0,
      sessionId,
      metadata: {
        ...input.metadata,
        model: {
          provider: input.model.provider,
          model: input.model.model,
          baseUrl: input.model.baseUrl ?? null,
          apiKeyEnv: input.model.apiKeyEnv ?? this.config.defaultModel?.apiKeyEnv ?? 'OPENAI_API_KEY',
          capabilities: input.model.capabilities ?? null,
          temperature: input.model.temperature,
          timeoutMs: input.model.timeoutMs,
          tokenParameter: input.model.tokenParameter,
          pricing: input.model.pricing,
        },
      },
    });
    const session: Session = SessionSchema.parse({
      schemaVersion: 1,
      id: sessionId,
      taskId,
      runId,
      kind: environment.kind,
      environment,
      lifecycle: 'starting',
      ownerId: 'pending',
      fencingToken: 0,
      capabilities: {
        observe: false,
        screenshot: false,
        click: false,
        type: false,
        unicodeType: false,
        scroll: false,
        drag: false,
        key: false,
        tabs: false,
        code: true,
        actions: [],
        notes: ['Capabilities are detected when the session starts.'],
      },
      createdAt,
      updatedAt: createdAt,
    });
    if (input.model.provider === 'scripted') {
      const steps = (input.script ?? []) as unknown as ScriptStep[];
      if (steps.length === 0) {
        throw new CuaError('PROTOCOL_INVALID', 'The scripted provider requires a non-empty script array.');
      }
      this.scripts.set(taskId, steps);
    } else if (!input.model.provider.startsWith('openai')) {
      throw new CuaError('PROTOCOL_INVALID', `Unsupported model provider "${input.model.provider}". Use "scripted" or an OpenAI-compatible provider.`);
    } else if (input.model.provider.startsWith('openai')) {
      const apiKeyEnv = input.model.apiKeyEnv ?? this.config.defaultModel?.apiKeyEnv ?? 'OPENAI_API_KEY';
      if (!process.env[apiKeyEnv]) {
        throw new CuaError(
          'MODEL_CAPABILITY_MISSING',
          `Real-model task needs ${apiKeyEnv}. The deterministic scripted provider remains available for local tests.`,
          { details: { provider: input.model.provider, model: input.model.model } },
        );
      }
    }
    this.store.createTask(task, {
      type: 'task.created',
      actor: 'system',
      payload: { goal: task.goal, environment: environment.kind, acceptance: task.acceptance, budgets },
    });
    this.store.createSession(session);
    this.emit('task-created', task);
    this.queue.push(taskId);
    this.schedule();
    return this.summary(taskId);
  }

  summary(taskId: string): TaskSummary {
    const task = this.store.requireTask(taskId);
    const observation = this.store.latestObservation(taskId);
    return {
      ...task,
      latestObservation: observation,
      lastEventSeq: this.store.lastEventSeq(taskId),
    } as TaskSummary;
  }

  listTasks(limit = 50): TaskSummary[] {
    return this.store.listTasks(limit).map((t) => this.summary(t.id));
  }

  getTask(taskId: string): TaskDetails {
    const task = this.store.requireTask(taskId);
    const sessions = this.store.listSessions(taskId);
    const session = task.sessionId ? sessions.find((s) => s.id === task.sessionId) : sessions[sessions.length - 1];
    const active = this.active.get(taskId);
    return {
      task,
      session,
      latestObservation: this.store.latestObservation(taskId),
      actions: this.store.listActions(taskId),
      verifications: this.store.listVerifications(taskId),
      events: this.store.listEvents(taskId, 0, 2_000),
      controller: active?.controller.snapshot(),
    };
  }

  getEvents(taskId: string | undefined, since = 0, limit = 500): ReturnType<SessionStore['listEvents']> {
    return this.store.listEvents(taskId, since, limit);
  }

  async awaitTask(taskId: string, options: { timeoutMs?: number; stopAtPause?: boolean } = {}): Promise<Task> {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    while (Date.now() < deadline) {
      const task = this.store.requireTask(taskId);
      if (isTerminal(task.status)) return task;
      if (options.stopAtPause && (task.status === 'paused' || task.status === 'awaiting_user' || task.status === 'needs_attention')) return task;
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.store.requireTask(taskId);
  }

  async pause(taskId: string): Promise<Task> {
    const active = this.active.get(taskId);
    if (!active) throw new CuaError('CONFLICT', `Task ${taskId} is not running in this process.`);
    await active.controller.pause();
    return this.store.requireTask(taskId);
  }

  async resume(taskId: string): Promise<Task> {
    const active = this.active.get(taskId);
    if (!active) throw new CuaError('CONFLICT', `Task ${taskId} is not running in this process. Resume requires recovery.`);
    await active.controller.resume();
    return this.store.requireTask(taskId);
  }

  async cancel(taskId: string, reason = 'Cancelled by user'): Promise<Task> {
    const active = this.active.get(taskId);
    if (active) {
      await active.controller.cancel(reason);
      return this.store.requireTask(taskId);
    }
    const task = this.store.requireTask(taskId);
    if (!isTerminal(task.status)) {
      const cancelled = this.store.updateTask(
        { ...task, status: 'cancelled', statusReason: reason, terminalReason: reason },
        { event: { type: 'task.cancelled', actor: 'user', payload: { reason } } },
      );
      return cancelled;
    }
    return task;
  }

  async takeover(taskId: string): Promise<Task> {
    const active = this.active.get(taskId);
    if (!active) throw new CuaError('CONFLICT', `Task ${taskId} is not running.`);
    await active.controller.takeover();
    this.store.releaseLease(active.session.id, active.ownerId, active.leaseFencing);
    return this.store.requireTask(taskId);
  }

  async release(taskId: string): Promise<Task> {
    const active = this.active.get(taskId);
    if (!active) throw new CuaError('CONFLICT', `Task ${taskId} is not running.`);
    const lease = this.store.acquireLease(active.session.id, active.ownerId, 10 * 60_000);
    active.leaseFencing = lease.fencingToken;
    await active.controller.release();
    return this.store.requireTask(taskId);
  }

  async submitInput(taskId: string, raw: unknown): Promise<Task> {
    const input: UserInput = UserInputSchema.parse(raw);
    const active = this.active.get(taskId);
    if (!active) throw new CuaError('CONFLICT', `Task ${taskId} is not running.`);
    const accepted = active.controller.submitUserInput(input);
    if (!accepted) throw new CuaError('CONFLICT', 'The task is not currently waiting for input.');
    return this.store.requireTask(taskId);
  }

  private schedule(): void {
    if (!this.started) return;
    while (this.active.size < this.config.maxConcurrency) {
      let chosen: string | undefined;
      let chosenResources: string[] = [];
      for (const taskId of this.queue) {
        const task = this.store.getTask(taskId);
        if (!task) continue;
        const resources = this.resourcesFor(task);
        if (resources.some((r) => this.busyResources.has(r))) continue;
        chosen = taskId;
        chosenResources = resources;
        break;
      }
      if (!chosen) return;
      this.queue.splice(this.queue.indexOf(chosen), 1);
      for (const resource of chosenResources) this.busyResources.add(resource);
      void this.startTask(chosen, chosenResources);
    }
  }

  private resourcesFor(task: Task): string[] {
    const resources = [`session:${task.sessionId ?? task.id}`];
    if (task.environment.kind === 'desktop') resources.push('desktop:global-input');
    const keys = task.metadata.resourceKeys;
    if (Array.isArray(keys)) {
      for (const key of keys) if (typeof key === 'string') resources.push(`res:${key}`);
    }
    if (typeof task.metadata.businessObject === 'string') resources.push(`business:${task.metadata.businessObject}`);
    return resources;
  }

  private async startTask(taskId: string, resources: string[]): Promise<void> {
    const task = this.store.requireTask(taskId);
    const sessions = this.store.listSessions(taskId);
    let session = sessions.find((s) => s.id === task.sessionId) ?? sessions[sessions.length - 1];
    if (!session) {
      this.releaseResources(resources);
      return;
    }
    let driver: Driver | undefined;
    try {
      driver = this.createDriver(task, session);
      const adapter = this.createAdapter(task);
      const planner = new Planner(adapter, {
        observationMode: this.config.observationMode,
        sendScreenshots: this.config.sendScreenshots,
        maxObservationTargets: 80,
      });
      const executor = new Executor(this.store, this.verifier);
      const budget = new BudgetTracker(task.budgets);
      const cancellation = new CancellationToken();
      const workflowHint = task.metadata.useWorkflow === true ? this.workflows.lookup(task) : undefined;
      const controller = new TaskController({
        task,
        session,
        store: this.store,
        driver,
        planner,
        executor,
        verifier: this.verifier,
        budget,
        cancellation,
        options: { closeOnFinish: true, ownerId: this.ownerId },
        workflowHint,
      });
      const lease = this.store.acquireLease(session.id, this.ownerId, 10 * 60_000);
      session = this.store.updateSession({ ...session, ownerId: this.ownerId, fencingToken: lease.fencingToken });
      const done = (async () => {
        try {
          await controller.start();
        } catch (error) {
          this.store.appendEvent({
            type: 'task.finished',
            actor: 'system',
            taskId,
            sessionId: session!.id,
            payload: { fatal: true, error: isCuaError(error) ? error.message : String(error) },
          });
        } finally {
          await driver!.close().catch(() => undefined);
          try {
            const finished = this.store.requireTask(taskId);
            if (finished.status === 'succeeded') this.workflows.learn(finished);
          } catch {
            // Workflow learning is optional evidence-based memory, not task state.
          }
          this.store.releaseLease(session!.id, this.ownerId, lease.fencingToken);
          this.active.delete(taskId);
          this.releaseResources(resources);
          this.scripts.delete(taskId);
          this.resolveWaiters(taskId);
          this.emit('task-settled', this.store.requireTask(taskId));
          this.schedule();
        }
      })();
      this.active.set(taskId, {
        controller,
        driver,
        session,
        ownerId: this.ownerId,
        leaseFencing: lease.fencingToken,
        resources,
        done,
      });
      this.emit('task-started', task);
    } catch (error) {
      await driver?.close().catch(() => undefined);
      this.releaseResources(resources);
      const current = this.store.requireTask(taskId);
      if (!isTerminal(current.status)) {
        try {
          this.store.updateTask(
            {
              ...current,
              status: 'needs_attention',
              statusReason: `Could not start session: ${isCuaError(error) ? error.message : String(error)}`,
            },
            { event: { type: 'task.status', actor: 'system', payload: { error: String(error) } } },
          );
        } catch {
          // Keep the original state if the transition is not allowed.
        }
      }
      this.resolveWaiters(taskId);
      this.schedule();
    }
  }

  private createDriver(task: Task, session: Session, readOnlyNetwork = false): Driver {
    if (task.environment.kind === 'browser') {
      return new BrowserDriver(
        { taskId: task.id, runId: task.runId, sessionId: session.id },
        task.environment,
        this.artifacts,
        { allowedOrigins: task.authorization.allowedOrigins, authorizationExpiresAt: task.authorization.expiresAt, readOnlyNetwork },
      );
    }
    return new MacDesktopDriver(
      { taskId: task.id, runId: task.runId, sessionId: session.id },
      task.environment,
      this.artifacts,
      { helperPath: this.config.helperPath },
    );
  }

  private createAdapter(task: Task) {
    const model = task.metadata.model as
      | {
          provider?: string;
          model?: string;
          baseUrl?: string;
          apiKeyEnv?: string;
          capabilities?: any;
          temperature?: number;
          timeoutMs?: number;
          tokenParameter?: 'max_tokens' | 'max_completion_tokens';
          pricing?: { inputPerMillionUsd: number; outputPerMillionUsd: number };
        }
      | undefined;
    if (!model || model.provider === 'scripted') {
      const steps = this.scripts.get(task.id);
      if (!steps) throw new CuaError('MODEL_CAPABILITY_MISSING', 'The scripted task has no script (it may have been restored after a restart).');
      return new ScriptedAdapter(steps);
    }
    return new OpenAICompatibleAdapter({
      model: model.model ?? 'gpt-4.1',
      baseUrl: model.baseUrl ?? this.config.defaultModel?.baseUrl,
      apiKeyEnv: model.apiKeyEnv ?? this.config.defaultModel?.apiKeyEnv ?? 'OPENAI_API_KEY',
      temperature: model.temperature,
      timeoutMs: model.timeoutMs,
      tokenParameter: model.tokenParameter,
      pricing: model.pricing,
      capabilities: {
        tools: model.capabilities?.tools ?? true,
        images: model.capabilities?.images ?? false,
        structuredOutput: model.capabilities?.structuredOutput ?? true,
        nativeComputerActions: false,
        notes: ['Configured through the task model block; API compatibility alone is not capability detection.'],
      },
    });
  }

  private releaseResources(resources: string[]): void {
    for (const resource of resources) this.busyResources.delete(resource);
  }

  private resolveWaiters(taskId: string): void {
    for (const resolve of this.waiters.get(taskId)?.splice(0) ?? []) resolve();
  }

  async recoverAll(): Promise<Task[]> {
    const tasks = this.store.listRecoverableTasks();
    const recovered: Task[] = [];
    for (const task of tasks) {
      recovered.push(await this.recoverTask(task.id));
    }
    return recovered;
  }

  /**
   * Conservative crash recovery: mark in-flight actions UNKNOWN, start a NEW
   * environment handle (old browser handles are never reused), read the actual
   * acceptance state, and never retry a write automatically. A failed or
   * inconclusive check ends in NEEDS_ATTENTION for a human decision.
   */
  async recoverTask(taskId: string): Promise<Task> {
    if (this.active.has(taskId)) throw new CuaError('CONFLICT', 'Cannot recover a live task; pause/cancel and account for its actions first.');
    let task = this.store.requireTask(taskId);
    if (isTerminal(task.status)) return task;
    const pending = this.store.listPendingActions(taskId);
    for (const action of pending) this.store.markActionUnknown(action.id, 'process restarted while action was in flight');
    const previousSessions = this.store.listSessions(taskId);
    for (const session of previousSessions) {
      if (session.lifecycle === 'active' || session.lifecycle === 'starting') {
        this.store.updateSession({ ...session, lifecycle: 'lost' });
        this.store.appendEvent({
          type: 'session.lost',
          actor: 'system',
          taskId,
          sessionId: session.id,
          payload: { reason: 'process restart / recovery' },
        });
      }
    }
    if (task.status !== 'recovering') {
      try {
        assertTransition(task.status, 'recovering');
        task = this.store.updateTask(
          { ...task, status: 'recovering', statusReason: 'Recovering after process/session loss' },
          {
            event: {
              type: 'task.recovered',
              actor: 'system',
              payload: { previousStatus: task.status, pendingActions: pending.map((a) => a.id) },
            },
          },
        );
      } catch (error) {
        // If the state cannot transition, leave it for a human rather than
        // hiding the inconsistency.
        task = this.store.updateTask(
          { ...task, status: 'needs_attention', statusReason: `Recovery could not start: ${String(error)}` },
          { event: { type: 'task.recovery_required', actor: 'system', payload: { error: String(error) } } },
        );
        return task;
      }
    }
    const sessionId = newId('ses');
    const session: Session = SessionSchema.parse({
      schemaVersion: 1,
      id: sessionId,
      taskId,
      runId: task.runId,
      kind: task.environment.kind,
      environment: task.environment,
      lifecycle: 'starting',
      ownerId: this.ownerId,
      fencingToken: 0,
      capabilities: {
        observe: false, screenshot: false, click: false, type: false, unicodeType: false,
        scroll: false, drag: false, key: false, tabs: false, code: true, actions: [],
        notes: ['Recovery session. Old handles are never reused.'],
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    this.store.createSession(session);
    task = this.store.updateTask({ ...task, sessionId });
    let driver: Driver | undefined;
    try {
      const externalChecks = new Set(['record_field', 'http_status', 'file_content', 'file_exists', 'custom']);
      const needsDriver = task.acceptance.some((criterion) => !externalChecks.has(criterion.kind));
      if (needsDriver) {
        // Do not run an application's startup scripts while reconciling an
        // uncertain write. SPA-only state can legitimately be unverifiable.
        driver = this.createDriver(task, session, true);
        await driver.start();
        this.store.updateSession({ ...session, lifecycle: 'active', capabilities: driver.capabilities() });
        const observation = await driver.observe();
        this.store.saveObservation(observation);
      } else {
        this.store.updateSession({ ...session, lifecycle: 'active' });
      }
      const verification = await this.verifier.verify({
        task,
        criteria: task.acceptance,
        scope: 'recovery',
        driver,
        waitMs: 3_000,
      });
      this.store.saveVerification(verification);
      const status = verification.verdict === 'pass' ? 'succeeded' : 'needs_attention';
      task = this.store.updateTask(
        { ...task, status, statusReason: `Recovery read-only verification: ${verification.verdict}` },
        {
          event: {
            type: status === 'succeeded' ? 'task.finished' : 'task.recovery_required',
            actor: 'system',
            payload: {
              verdict: verification.verdict,
              details: verification.details,
              pendingActions: pending.map((a) => a.id),
              note:
                status === 'succeeded'
                  ? 'Acceptance was already true after restart; no write was retried.'
                  : 'Recovery did not retry any write. A human must decide how to proceed.',
            },
          },
        },
      );
      return task;
    } catch (error) {
      task = this.store.updateTask(
        {
          ...task,
          status: 'needs_attention',
          statusReason: `Recovery could not inspect the environment: ${isCuaError(error) ? error.message : String(error)}`,
        },
        { event: { type: 'task.recovery_required', actor: 'system', payload: { error: String(error) } } },
      );
      return task;
    } finally {
      await driver?.close().catch(() => undefined);
      this.store.updateSession({ ...session, lifecycle: 'closed' });
    }
  }

  async close(): Promise<void> {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    for (const [taskId, active] of this.active) {
      try {
        await active.controller.cancel('Service shutting down');
        await Promise.race([active.done, new Promise((r) => setTimeout(r, 5_000))]);
      } catch {
        // Best-effort shutdown; the action intent remains for recovery.
      }
      void taskId;
    }
    this.store.close();
    this.started = false;
  }

  metrics(): Metrics {
    const tasks = this.store.listTasks(10_000);
    const finished = tasks.filter((t) => isTerminal(t.status));
    const succeeded = tasks.filter((t) => t.status === 'succeeded').length;
    const failed = tasks.filter((t) => t.status === 'failed').length;
    const needsAttention = tasks.filter((t) => t.status === 'needs_attention').length;
    const cancelled = tasks.filter((t) => t.status === 'cancelled').length;
    const inProgress = tasks.length - finished.length - needsAttention;
    const recoveryTasks = tasks.filter((t) => this.store.listEvents(t.id, 0, 10_000)
      .some((e) => e.type === 'task.recovered' || e.type === 'task.recovery_required'));
    const recoverySuccess = recoveryTasks.filter((t) => t.status === 'succeeded').length;
    const falseCompletion = tasks
      .filter((t) => t.status === 'succeeded')
      .filter((t) => !this.store.listVerifications(t.id)
        .some((v) => (v.scope === 'task' || v.scope === 'recovery') && v.verdict === 'pass')).length;
    const allEvents = this.store.listEvents(undefined, 0, 100_000);
    const intents = allEvents.filter((e) => e.type === 'action.intent');
    const seenSignatures = new Map<string, string>();
    let duplicateActionIntents = 0;
    for (const event of intents) {
      if (!event.taskId) continue;
      const signature = actionSignature(event.payload.action ?? event.payload.tool ?? {});
      const key = `${event.taskId}:${signature}`;
      if (seenSignatures.has(key)) duplicateActionIntents += 1;
      else seenSignatures.set(key, signature);
    }
    const durations = finished
      .map((t) => Date.parse(t.updatedAt) - Date.parse(t.createdAt))
      .filter((n) => Number.isFinite(n) && n >= 0);
    return {
      sampleSize: tasks.length,
      succeeded,
      failed,
      needsAttention,
      cancelled,
      inProgress: Math.max(0, inProgress),
      successRate: finished.length ? succeeded / finished.length : null,
      falseCompletionRate: finished.length ? falseCompletion / finished.length : null,
      recoveryCount: recoveryTasks.length,
      recoverySuccessCount: recoverySuccess,
      duplicateActionIntents,
      modelCalls: allEvents.filter((e) => e.type === 'model.request').length,
      codeRuns: allEvents.filter((e) => e.type === 'action.intent' && e.payload.tool === 'code.run').length,
      actionCount: intents.length,
      averageDurationMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      note: 'False completion counts succeeded tasks without a passing task/recovery acceptance verification, divided by terminal tasks. Recovery counts tasks with recovery events. Duplicate action intents do not measure duplicate GUI side effects. Metrics cover at most 10,000 tasks and 100,000 events; criteria quality is evaluated separately.',
    };
  }

  async getArtifact(id: string) {
    return this.artifacts.readById(id);
  }

  listWorkflows() {
    return this.workflows.list();
  }

  deleteWorkflow(name: string): boolean {
    if (!name.trim() || name.length > 1_000) throw new CuaError('PROTOCOL_INVALID', 'An explicit workflow name (1–1000 characters) is required.');
    return this.workflows.delete(name);
  }

  invalidateWorkflow(taskId: string): void {
    const task = this.store.requireTask(taskId);
    this.workflows.invalidate(task, 'user request');
  }
}
