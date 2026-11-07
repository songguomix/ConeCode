import { newId } from '../protocol/ids.js';
import { CuaError, isCuaError } from '../protocol/errors.js';
import { assertObservationFresh } from '../protocol/observation-utils.js';
import {
  ActionProposalSchema,
  ActionSchema,
  ConditionSchema,
  isReadOnlyAction,
  isTerminal,
  nowIso,
  type Action,
  type ActionProposal,
  type Condition,
  type ExecutionResult,
  type Observation,
  type Task,
} from '../protocol/schemas.js';
import type { Driver } from '../drivers/types.js';
import type { BudgetTracker, CancellationToken } from '../runtime/control.js';
import type { SessionStore } from '../store/store.js';
import { assertPathWithin, type Verifier } from './verifier.js';
import { CodeRuntime, type CodeRuntimeOptions } from '../runtime/code-runtime.js';
import { observationForModel } from '../protocol/observation-utils.js';

export interface ExecuteInput {
  task: Task;
  observation: Observation;
  proposal: ActionProposal;
  driver: Driver;
  budget: BudgetTracker;
  cancellation: CancellationToken;
  approved?: boolean;
}

export interface ExecuteOutput {
  result: ExecutionResult;
  verificationId?: string;
}

/**
 * The only path from an ActionProposal to a driver. It validates authorization,
 * freshness and target actionability, writes intent BEFORE the action, then
 * records the actual result and postcondition evidence. An exception from a
 * driver is never converted into "business success".
 */
export class Executor {
  private codeRuntime?: CodeRuntime;
  private readonly liveActions = new Set<string>();

  hasInFlightActions(): boolean { return this.liveActions.size > 0; }

  constructor(
    private readonly store: SessionStore,
    private readonly verifier: Verifier,
    private readonly options: {
      actionTimeoutMs?: number;
      writeTimeoutMs?: number;
      codeRuntime?: CodeRuntime;
      codeRuntimeOptions?: CodeRuntimeOptions;
    } = {},
  ) {
    this.codeRuntime = options.codeRuntime;
  }

  async execute(input: ExecuteInput): Promise<ExecuteOutput> {
    const { observation, driver, budget, cancellation } = input;
    const task = this.store.requireTask(input.task.id);
    const proposal = ActionProposalSchema.parse(input.proposal);
    if (proposal.taskId !== task.id || proposal.runId !== task.runId || proposal.sessionId !== task.sessionId ||
        observation.taskId !== task.id || observation.runId !== task.runId || observation.sessionId !== proposal.sessionId ||
        proposal.observationId !== observation.id || proposal.surfaceId !== observation.surfaceId || proposal.generation !== observation.generation) {
      throw new CuaError('PROTOCOL_INVALID', 'Task, run, session, surface and observation references must match before execution.');
    }
    const action = ActionSchema.parse(proposal.action);
    if (action.tool === 'task.finish') {
      throw new CuaError('PROTOCOL_INVALID', 'task.finish is handled by the TaskController verifier, not the Executor.');
    }
    if (cancellation.cancelled) throw new CuaError('CANCELLED', 'Task was cancelled before the action started.');
    this.authorize(task, action, input.approved === true);

    this.assertControl(task, proposal.sessionId, action);
    const live = await driver.freshness();
    cancellation.throwIfCancelled();
    this.assertControl(this.store.requireTask(task.id), proposal.sessionId, action);
    this.authorize(this.store.requireTask(task.id), action, input.approved === true);
    if (action.tool === 'desktop.edit_document' && driver.kind === 'desktop') {
      // App scripting names TextEdit and an explicit save path; it does not
      // use the observed foreground window, focus or screenshot coordinates.
      // Approval may itself change the foreground. Preserve session/surface
      // identity and a registered observation while allowing that focus drift.
      const registered = this.store.getObservation(observation.id);
      if (!registered || registered.taskId !== task.id || registered.runId !== task.runId ||
          registered.sessionId !== proposal.sessionId || registered.surfaceId !== observation.surfaceId ||
          registered.generation !== observation.generation || live.surfaceId !== observation.surfaceId) {
        throw new CuaError('OBSERVATION_STALE', 'The explicit document action requires a registered observation from this same desktop session and surface.');
      }
    } else {
      assertObservationFresh(observation, live);
    }
    const targetId = targetOf(action);
    if (targetId) this.validateTarget(observation, targetId);

    budget.addStep();
    budget.assertTime();
    const proposalWithObservation = Object.assign(Object.create(Object.getPrototypeOf(proposal)), proposal, {
      observation,
    }) as ActionProposal;
    this.store.recordActionIntent({
      ...proposalWithObservation,
      targetRef: targetId
        ? {
            observationId: observation.id,
            generation: observation.generation,
            targetId,
            frameId: observation.targets.find((t) => t.targetId === targetId)?.frameId ?? 'main',
            surfaceId: observation.surfaceId,
          }
        : proposal.targetRef,
    });

    const startedAt = nowIso();
    const write = !isReadOnlyAction(action);
    const timeoutMs = write ? (this.options.writeTimeoutMs ?? 45_000) : (this.options.actionTimeoutMs ?? 20_000);
    if (action.tool === 'code.run') {
      const codeResult = await this.executeCode(task, observation, proposal, driver, budget, cancellation, action);
      this.store.recordActionResult(codeResult);
      return { result: codeResult };
    }

    let outcome: Awaited<ReturnType<Driver['execute']>> | undefined;
    let failure: CuaError | undefined;
    let timedOut = false;
    try {
      this.liveActions.add(proposal.id);
      const operation = driver.execute(proposalWithObservation);
      // A timeout does not cancel a GUI command. Keep ownership blocked until
      // the actual driver promise settles, even after an UNKNOWN result.
      void operation.then(() => this.liveActions.delete(proposal.id), () => this.liveActions.delete(proposal.id));
      outcome = await withTimeout(operation, timeoutMs);
    } catch (error) {
      if (error instanceof TimeoutError) {
        timedOut = true;
      } else {
        failure = isCuaError(error)
          ? error
          : new CuaError('DRIVER_ERROR', error instanceof Error ? error.message : String(error), {
              cause: error,
              retryable: true,
            });
      }
    }
    const endedAt = nowIso();
    const evidence = [...(outcome?.evidence ?? [])];
    const actual: Record<string, unknown> = { ...(outcome?.actual ?? {}) };
    let verificationId: string | undefined;
    let status: ExecutionResult['status'] = 'succeeded';
    let sideEffectUnknown = false;
    let verificationVerdict: string | undefined;

    if (timedOut) {
      actual.timeoutMs = timeoutMs;
      actual.executionStillRunning = this.liveActions.has(proposal.id);
      if (write) {
        status = 'unknown';
        sideEffectUnknown = true;
        failure = new CuaError('UNKNOWN_OUTCOME', `Action did not return within ${timeoutMs}ms; its effect is unknown.`, {
          sideEffectMayHaveHappened: true,
        });
      } else {
        status = 'failed';
        failure = new CuaError('DRIVER_ERROR', `Read-only action did not return within ${timeoutMs}ms.`, {
          retryable: true,
        });
      }
    } else if (failure) {
      status = classifyFailure(failure, write);
      sideEffectUnknown = status === 'unknown';
    } else if (outcome?.sideEffectUnknown) {
      status = 'unknown';
      sideEffectUnknown = true;
      failure = new CuaError('UNKNOWN_OUTCOME', 'Driver reported that the effect could not be determined.', {
        sideEffectMayHaveHappened: true,
      });
    } else if (proposal.expected.length > 0) {
      try {
        const verification = await this.verifier.verify({
          task,
          criteria: proposal.expected,
          scope: 'action',
          actionId: proposal.id,
          driver,
          waitMs: 4_000,
        });
        this.store.saveVerification(verification);
        verificationId = verification.id;
        verificationVerdict = verification.verdict;
        actual.verification = {
          verdict: verification.verdict,
          details: verification.details,
          evidence: verification.evidence,
        };
        evidence.push({ kind: 'verification', ref: verification.id });
        if (verification.verdict === 'fail') {
          status = 'failed';
          failure = new CuaError('VERIFICATION_FAILED', 'The action returned but its postcondition did not pass.', {
            retryable: true,
            details: { verification: verification.details },
          });
        } else if (verification.verdict !== 'pass') {
          status = write ? 'unknown' : 'failed';
          sideEffectUnknown = write;
          failure = new CuaError('INSUFFICIENT_EVIDENCE', 'The action returned but its postcondition could not be confirmed.', {
            retryable: true,
            details: { verification: verification.details },
          });
        }
      } catch (error) {
        status = write ? 'unknown' : 'failed';
        sideEffectUnknown = write;
        failure = isCuaError(error)
          ? error
          : new CuaError('VERIFICATION_FAILED', `Postcondition verification crashed: ${String(error)}`);
      }
    }

    const result: ExecutionResult = {
      schemaVersion: 1,
      actionId: proposal.id,
      taskId: task.id,
      sessionId: proposal.sessionId,
      status,
      startedAt,
      endedAt,
      returned: outcome !== undefined,
      sideEffectUnknown,
      actual: {
        ...actual,
        ...(verificationVerdict ? { verificationVerdict } : {}),
        ...(timedOut ? { timedOut: true } : {}),
      },
      error: failure
        ? { code: failure.code, message: failure.message, retryable: failure.retryable }
        : undefined,
      evidence,
    };
    this.store.recordActionResult(result);
    return { result, verificationId };
  }

  private async executeCode(
    task: Task,
    observation: Observation,
    proposal: ActionProposal,
    driver: Driver,
    budget: BudgetTracker,
    cancellation: CancellationToken,
    action: Extract<Action, { tool: 'code.run' }>,
  ): Promise<ExecutionResult> {
    if (!task.authorization.allowCode) {
      throw new CuaError('AUTHORIZATION_DENIED', 'Code execution was not authorized for this task.');
    }
    budget.addCodeRun();
    if (!this.codeRuntime) {
      this.codeRuntime = new CodeRuntime(this.options.codeRuntimeOptions);
    }
    const startedAt = nowIso();
    const uiActions: Array<Record<string, unknown>> = [];
    let nestedUnknown = false;
    const abort = new AbortController();
    const offCancel = cancellation.onCancel(() => abort.abort());
    let currentObservation = observation;
    const executed: Array<{ kind: 'observation'; ref: string; note?: string }> = [];
    const runtime = this.codeRuntime;
    const codeResult = await runtime.run(action.code, {
      timeoutMs: action.timeoutMs,
      signal: cancellation.cancelled ? AbortSignal.abort() : abort.signal,
      executed,
      onUi: async (method, args) => {
        cancellation.throwIfCancelled();
        if (nestedUnknown) throw new CuaError('UNKNOWN_OUTCOME', 'A previous UI action has an unknown outcome; further UI calls are blocked.');
        if (method === 'observe') {
          const fresh = await driver.observe();
          this.store.saveObservation(fresh);
          currentObservation = fresh;
          return observationForModel(fresh);
        }
        if (method === 'wait') {
          const ms = Math.max(0, Math.min(Number(args.ms ?? 250), 30_000));
          await new Promise((r) => setTimeout(r, ms));
          return { waitedMs: ms };
        }
        const nested = this.buildCodeProposal(task, proposal, currentObservation, method, args);
        this.store.appendEvent({
          type: 'code.started',
          actor: 'executor',
          taskId: task.id,
          sessionId: proposal.sessionId,
          actionId: nested.id,
          payload: { method, args: redactCodeArgs(args), parentActionId: proposal.id },
        });
        const nestedResult = await this.execute({
          task,
          observation: currentObservation,
          proposal: nested,
          driver,
          budget,
          cancellation,
          approved: true,
        });
        nestedUnknown ||= nestedResult.result.status === 'unknown' || nestedResult.result.sideEffectUnknown;
        uiActions.push({
          actionId: nested.id,
          tool: nested.action.tool,
          status: nestedResult.result.status,
          error: nestedResult.result.error,
        });
        executed.push({ kind: 'observation', ref: nested.id, note: nested.action.tool });
        this.store.appendEvent({
          type: 'code.finished',
          actor: 'executor',
          taskId: task.id,
          sessionId: proposal.sessionId,
          actionId: nested.id,
          payload: { status: nestedResult.result.status, parentActionId: proposal.id },
        });
        if (nestedResult.result.status !== 'succeeded') {
          const error: any = new Error(nestedResult.result.error?.message ?? `UI action ${method} failed`);
          error.code = nestedResult.result.error?.code ?? 'DRIVER_ERROR';
          error.sideEffectMayHaveHappened = nestedResult.result.sideEffectUnknown;
          throw error;
        }
        return {
          actionId: nested.id,
          status: nestedResult.result.status,
          actual: nestedResult.result.actual,
        };
      },
    });
    offCancel();
    const endedAt = nowIso();
    let status: ExecutionResult['status'] = codeResult.ok ? 'succeeded' : codeResult.timedOut ? 'unknown' : 'failed';
    let sideEffectUnknown = codeResult.timedOut || codeResult.sessionLost;
    if (nestedUnknown || codeResult.sessionLost || !codeResult.stopped) {
      status = 'unknown';
      sideEffectUnknown = true;
    } else if (codeResult.ok) {
      status = 'succeeded';
      sideEffectUnknown = false;
    } else if (uiActions.length > 0 && !codeResult.timedOut) {
      status = 'partial';
      sideEffectUnknown = false;
    }
    const error = codeResult.error
      ? { code: codeResult.timedOut ? 'CODE_TIMEOUT' : 'DRIVER_ERROR', message: codeResult.error.message, retryable: false }
      : undefined;
    return {
      schemaVersion: 1,
      actionId: proposal.id,
      taskId: task.id,
      sessionId: proposal.sessionId,
      status,
      startedAt,
      endedAt,
      returned: !codeResult.timedOut,
      sideEffectUnknown,
      actual: {
        value: codeResult.value ?? null,
        logs: codeResult.logs,
        durationMs: codeResult.durationMs,
        timedOut: codeResult.timedOut,
        stopped: codeResult.stopped,
        sessionLost: codeResult.sessionLost,
        uiActions,
      },
      error,
      evidence: [
        ...uiActions.map((a) => ({ kind: 'event' as const, ref: String(a.actionId), note: String(a.tool) })),
        ...executed.map((e) => ({ kind: 'observation' as const, ref: e.ref, note: e.note })),
      ],
    };
  }

  private buildCodeProposal(
    task: Task,
    parent: ActionProposal,
    observation: Observation,
    method: string,
    args: Record<string, unknown>,
  ): ActionProposal {
    const desktop = task.environment.kind === 'desktop';
    const targetId = this.resolveCodeTarget(observation, args);
    const expectedRaw = Array.isArray(args.expected) ? args.expected : [];
    const expected: Condition[] = [];
    for (const item of expectedRaw) {
      const parsed = ConditionSchema.safeParse(item);
      if (parsed.success) expected.push(parsed.data);
    }
    let action: Action;
    switch (method) {
      case 'click':
        action = desktop
          ? { tool: 'desktop.click', x: Number(args.x), y: Number(args.y), button: 'left', clickCount: Number(args.clickCount ?? 1) }
          : {
              tool: 'browser.click',
              ...(targetId ? { targetId } : {}),
              ...(Array.isArray(args.coordinate) ? { coordinate: args.coordinate as [number, number] } : {}),
              button: (args.button as 'left' | 'right' | 'middle') ?? 'left',
              clickCount: Number(args.clickCount ?? 1),
            };
        break;
      case 'fill':
        if (!targetId) throw new CuaError('PROTOCOL_INVALID', 'ui.fill needs a targetId or target selector.');
        action = { tool: 'browser.fill', targetId, value: String(args.value ?? '') };
        if (!expected.some((c) => c.kind === 'value_equals')) {
          expected.push({ kind: 'value_equals', targetId, value: String(args.value ?? ''), withinMs: 3_000 });
        }
        break;
      case 'type':
        action = desktop
          ? { tool: 'desktop.type', text: String(args.text ?? '') }
          : { tool: 'browser.type', text: String(args.text ?? ''), ...(targetId ? { targetId } : {}), clearFirst: false };
        break;
      case 'press':
        action = desktop
          ? { tool: 'desktop.key', key: String(args.key ?? '') }
          : { tool: 'browser.press', key: String(args.key ?? ''), ...(targetId ? { targetId } : {}) };
        break;
      case 'scroll':
        action = desktop
          ? {
              tool: 'desktop.scroll',
              direction: (args.direction as 'up' | 'down' | 'left' | 'right') ?? 'down',
              amount: Number(args.amount ?? 3),
              ...(args.x !== undefined ? { x: Number(args.x), y: Number(args.y) } : {}),
            }
          : {
              tool: 'browser.scroll',
              direction: (args.direction as 'up' | 'down' | 'left' | 'right') ?? 'down',
              amount: Number(args.amount ?? 3),
              ...(targetId ? { targetId } : {}),
            };
        break;
      case 'screenshot':
        action = desktop ? { tool: 'desktop.screenshot' } : { tool: 'browser.screenshot' };
        break;
      default:
        throw new CuaError('PROTOCOL_INVALID', `Unsupported ui.${method} in code runtime.`);
    }
    return ActionProposalSchema.parse({
      schemaVersion: 1,
      id: newId('act'),
      taskId: task.id,
      runId: parent.runId,
      sessionId: parent.sessionId,
      observationId: observation.id,
      surfaceId: observation.surfaceId,
      generation: observation.generation,
      action,
      expected,
      risk: 'reversible',
      requiresApproval: false,
      rationale: `code.run ui.${method}`,
      createdAt: nowIso(),
      attempts: 0,
    });
  }

  private resolveCodeTarget(observation: Observation, args: Record<string, unknown>): string | undefined {
    if (typeof args.targetId === 'string') return args.targetId;
    const selector = args.target;
    if (!selector || typeof selector !== 'object') return undefined;
    const s = selector as { targetId?: unknown; role?: unknown; name?: unknown; ordinal?: unknown };
    if (typeof s.targetId === 'string') return s.targetId;
    let matches = observation.targets.filter((t) => t.visible);
    if (typeof s.role === 'string') matches = matches.filter((t) => t.role === s.role);
    if (typeof s.name === 'string') matches = matches.filter((t) => t.name.toLowerCase() === String(s.name).toLowerCase());
    if (matches.length === 1) return matches[0]!.targetId;
    if (matches.length > 1 && typeof s.ordinal === 'number') return matches[s.ordinal]?.targetId;
    throw new CuaError('TARGET_AMBIGUOUS', `Code ui target selector matched ${matches.length} elements.`);
  }

  async close(): Promise<void> {
    await this.codeRuntime?.close();
    this.codeRuntime = undefined;
  }

  private assertControl(task: Task, sessionId: string, action: Action): void {
    const session = this.store.getSession(sessionId);
    if (!session || session.taskId !== task.id || session.runId !== task.runId || task.sessionId !== sessionId) {
      throw new CuaError('CONFLICT', 'The execution session is no longer owned by this task run.');
    }
    if (isTerminal(task.status) || task.status === 'paused' || task.status === 'recovering' ||
        task.status === 'verifying_unknown' || session.lifecycle === 'taken_over' || session.lifecycle === 'closed' || session.lifecycle === 'lost') {
      throw new CuaError('CONFLICT', 'Execution is blocked while terminal, paused, recovering or under user control.');
    }
    if (!isReadOnlyAction(action) && this.store.listActions(task.id, 100_000).some((stored) => stored.status === 'unknown' || stored.result?.sideEffectUnknown)) {
      throw new CuaError('UNKNOWN_OUTCOME', 'An earlier action has unresolved side effects. Reconcile read-only before further writes.');
    }
  }

  private authorize(task: Task, action: Action, approved: boolean): void {
    const scope = task.authorization;
    if (scope.expiresAt && Date.parse(scope.expiresAt) <= Date.now()) {
      throw new CuaError('AUTHORIZATION_DENIED', 'The task authorization has expired. Re-authorize before acting.', {
        retryable: false,
      });
    }
    if (scope.allowedTools.length > 0) {
      const allowed = scope.allowedTools.some((entry) => {
        if (entry === '*') return true;
        if (entry.endsWith('.*')) return action.tool.startsWith(entry.slice(0, -1));
        return entry === action.tool;
      });
      if (!allowed) {
        throw new CuaError('AUTHORIZATION_DENIED', `Tool "${action.tool}" is outside the task's allowedTools.`, {
          details: { allowedTools: scope.allowedTools },
        });
      }
    }
    if (action.tool.startsWith('desktop.') && !scope.allowDesktop) {
      throw new CuaError('AUTHORIZATION_DENIED', 'Desktop control was not authorized for this task.');
    }
    if (action.tool === 'code.run' && !scope.allowCode) {
      throw new CuaError('AUTHORIZATION_DENIED', 'Code execution was not authorized for this task.');
    }
    if (action.tool === 'desktop.edit_document') {
      assertPathWithin(action.savePath, scope.allowedFileRoots);
      if (!approved) throw new CuaError('APPROVAL_REQUIRED', 'Writing a named TextEdit document requires explicit approval.');
    }
    if (action.tool === 'browser.navigate' || action.tool === 'browser.open_tab') {
      if (action.url) this.authorizeUrl(task, action.url);
    }
    if (action.tool === 'code.run' && !approved) {
      throw new CuaError('APPROVAL_REQUIRED', 'Code execution needs explicit user approval for this task.');
    }
  }

  private authorizeUrl(task: Task, url: string): void {
    const origin = new URL(url).origin;
    const allowed = task.authorization.allowedOrigins;
    if (allowed.length === 0) {
      throw new CuaError('AUTHORIZATION_DENIED', 'Navigation requires an explicit allowedOrigins scope.');
    }
    if (
      !allowed.some((entry) => {
        if (entry === '*') return true;
        try {
          return new URL(entry).origin === origin;
        } catch {
          return entry === origin;
        }
      })
    ) {
      throw new CuaError('AUTHORIZATION_DENIED', `Origin ${origin} is outside the task's allowedOrigins.`, {
        details: { allowedOrigins: allowed },
      });
    }
  }

  private validateTarget(observation: Observation, targetId: string): void {
    const target = observation.targets.find((t) => t.targetId === targetId);
    if (!target) {
      throw new CuaError('TARGET_NOT_FOUND', `Target ${targetId} is absent from the observation. Re-observe.`, {
        details: { observationId: observation.id },
      });
    }
    if (!target.visible) throw new CuaError('TARGET_NOT_ACTIONABLE', `Target ${targetId} is not visible.`);
    if (!target.actionable) throw new CuaError('TARGET_NOT_ACTIONABLE', `Target ${targetId} is disabled or not actionable.`);
  }
}

function redactCodeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (/pass(word)?|secret|token|api[-_]?key/i.test(key)) copy[key] = '[redacted]';
    else if (typeof value === 'string') copy[key] = value.slice(0, 300);
    else copy[key] = value;
  }
  return copy;
}

function targetOf(action: Action): string | undefined {
  if ('targetId' in action && typeof action.targetId === 'string') return action.targetId;
  if (action.tool === 'browser.drag') return action.fromTargetId ?? action.toTargetId;
  return undefined;
}

function classifyFailure(error: CuaError, write: boolean): ExecutionResult['status'] {
  if (!write) return 'failed';
  if (
    error.code === 'TARGET_STALE' ||
    error.code === 'TARGET_NOT_FOUND' ||
    error.code === 'TARGET_AMBIGUOUS' ||
    error.code === 'TARGET_NOT_ACTIONABLE' ||
    error.code === 'OBSERVATION_STALE' ||
    error.code === 'AUTHORIZATION_DENIED' ||
    error.code === 'APPROVAL_REQUIRED' ||
    error.code === 'PROTOCOL_INVALID'
  ) {
    return 'failed';
  }
  if (error.sideEffectMayHaveHappened) return 'unknown';
  if (error.retryable) return 'unknown';
  return 'failed';
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export { newId };
