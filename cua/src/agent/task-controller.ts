import { EventEmitter } from 'node:events';
import { newId } from '../protocol/ids.js';
import { CuaError, isCuaError } from '../protocol/errors.js';
import { actionSignature, semanticActionSignature } from '../protocol/observation-utils.js';
import {
  ActionProposalSchema,
  isTerminal,
  nowIso,
  type ActionProposal,
  type Condition,
  type Observation,
  type Session,
  type Task,
  type TaskStatus,
  type UserInput,
} from '../protocol/schemas.js';
import type { Driver } from '../drivers/types.js';
import type { BudgetTracker, CancellationToken } from '../runtime/control.js';
import type { SessionStore } from '../store/store.js';
import type { ModelMessage } from '../model/types.js';
import { initialMessages, Planner, type PlannerDecision } from './planner.js';
import { compactMessages } from './context.js';
import type { WorkflowHint } from './workflow-memory.js';
import type { Executor } from './executor.js';
import type { Verifier } from './verifier.js';

export interface TaskControllerOptions {
  /** Close driver resources when the task reaches a terminal state. */
  closeOnFinish?: boolean;
  /** Do not automatically run; used by the service when a task is queued. */
  ownerId?: string;
  maxIdenticalActions?: number;
  maxFinishAttempts?: number;
  userInputTimeoutMs?: number;
}

export interface ControllerDeps {
  task: Task;
  session: Session;
  store: SessionStore;
  driver: Driver;
  planner: Planner;
  executor: Executor;
  verifier: Verifier;
  budget: BudgetTracker;
  cancellation: CancellationToken;
  options?: TaskControllerOptions;
  workflowHint?: WorkflowHint;
}

export interface ControllerSnapshot {
  task: Task;
  session: Session;
  step: number;
  finishAttempts: number;
  pauseRequested: boolean;
  cancelRequested: boolean;
  currentActionId?: string;
  awaitingUser?: { kind: 'approval' | 'answer' | 'freeform'; question: string; actionId?: string };
  lastObservation?: Observation;
}

/**
 * Owns one task run. The loop is deliberately sequential: observe -> plan ->
 * execute -> verify -> observe. Writes to one session are serialized here and
 * by the service's session mutex. Model completion is probed, never trusted.
 */
export class TaskController extends EventEmitter {
  private task: Task;
  private session: Session;
  private readonly store: SessionStore;
  private readonly driver: Driver;
  private readonly planner: Planner;
  private readonly executor: Executor;
  private readonly verifier: Verifier;
  private readonly budget: BudgetTracker;
  private readonly cancellation: CancellationToken;
  private readonly options: Required<Pick<TaskControllerOptions, 'closeOnFinish' | 'maxIdenticalActions' | 'maxFinishAttempts' | 'userInputTimeoutMs'>>;
  private messages: ModelMessage[];
  private step = 0;
  private finishAttempts = 0;
  private modelErrorCount = 0;
  private lastFinishVerdict?: string;
  private pauseRequested = false;
  private pauseWake?: () => void;
  private controlEpoch = 0;
  private cancelRequested = false;
  private currentActionId?: string;
  private lastObservation?: Observation;
  private lastActionResult?: { tool: string; status: string; error?: string; verification?: string };
  private lastSignature?: string;
  private identicalCount = 0;
  private readonly failedActions = new Map<string, number>();
  private pendingApproval?: { proposal: ActionProposal; resolve: (approved: boolean) => void };
  private pendingInput?: { resolve: (input: UserInput) => void; question: string };
  private runPromise?: Promise<void>;
  private settled = false;
  private startedAt = Date.now();

  constructor(private readonly deps: ControllerDeps) {
    super();
    this.task = deps.task;
    this.session = deps.session;
    this.store = deps.store;
    this.driver = deps.driver;
    this.planner = deps.planner;
    this.executor = deps.executor;
    this.verifier = deps.verifier;
    this.budget = deps.budget;
    this.cancellation = deps.cancellation;
    this.options = {
      closeOnFinish: deps.options?.closeOnFinish ?? true,
      maxIdenticalActions: deps.options?.maxIdenticalActions ?? 3,
      maxFinishAttempts: deps.options?.maxFinishAttempts ?? 2,
      userInputTimeoutMs: deps.options?.userInputTimeoutMs ?? 10 * 60_000,
    };
    this.messages = initialMessages(
      this.task,
      this.planner.capabilities(),
      this.driver.kind === 'desktop' ? 'desktop' : 'browser',
      deps.workflowHint,
    );
  }

  snapshot(): ControllerSnapshot {
    return {
      task: this.task,
      session: this.session,
      step: this.step,
      finishAttempts: this.finishAttempts,
      pauseRequested: this.pauseRequested,
      cancelRequested: this.cancelRequested,
      currentActionId: this.currentActionId,
      awaitingUser: this.pendingApproval
        ? { kind: 'approval', question: 'Approve this action?', actionId: this.pendingApproval.proposal.id }
        : this.pendingInput
          ? { kind: 'answer', question: this.pendingInput.question }
          : undefined,
      lastObservation: this.lastObservation,
    };
  }

  async start(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    this.runPromise = this.runLoop().catch((error) => this.onFatal(error));
    return this.runPromise;
  }

  wait(): Promise<void> {
    return this.runPromise ?? Promise.resolve();
  }

  async pause(reason = 'Paused by user'): Promise<void> {
    this.pauseRequested = true;
    this.controlEpoch += 1;
    this.store.appendEvent({
      type: 'task.paused',
      actor: 'user',
      taskId: this.task.id,
      runId: this.task.runId,
      sessionId: this.session.id,
      payload: {
        reason,
        actionInFlight: this.currentActionId,
        note: this.currentActionId
          ? 'An action is still running. Cancellation/pause is not a rollback; the action will be accounted for.'
          : 'Pausing between actions.',
      },
    });
    this.emit('change', this.snapshot());
    if (!this.currentActionId && !isTerminal(this.task.status) && this.task.status !== 'paused') {
      await this.transition('paused', reason);
    }
  }

  async cancel(reason = 'Cancelled by user'): Promise<void> {
    this.cancelRequested = true;
    this.cancellation.cancel(reason);
    this.store.appendEvent({
      type: 'task.cancel_requested',
      actor: 'user',
      taskId: this.task.id,
      runId: this.task.runId,
      sessionId: this.session.id,
      actionId: this.currentActionId,
      payload: {
        reason,
        actionInFlight: this.currentActionId,
        note: this.currentActionId
          ? 'Cancellation was requested while an action was in flight. The action is NOT rolled back; its result must be reconciled.'
          : 'No action in flight.',
      },
    });
    this.pauseWake?.();
    this.pendingInput?.resolve({ kind: 'freeform', text: 'cancel' });
    this.pendingApproval?.resolve(false);
    this.emit('change', this.snapshot());
  }

  async takeover(): Promise<void> {
    this.pauseRequested = true;
    this.controlEpoch += 1;
    if (this.currentActionId) {
      const settled = await this.waitForInflightAction(60_000);
      if (!settled) {
        throw new CuaError(
          'CONFLICT',
          `Ownership was NOT transferred: action ${this.currentActionId} is still in flight. Wait for its result or cancel and reconcile it.`,
          { details: { actionId: this.currentActionId } },
        );
      }
    }
    if (this.executor.hasInFlightActions()) {
      throw new CuaError('CONFLICT', 'Ownership was NOT transferred: a timed-out driver action is still running; wait and reconcile its result.');
    }
    this.session = this.store.updateSession({ ...this.session, lifecycle: 'taken_over', ownerId: 'user' });
    this.store.appendEvent({
      type: 'session.takeover',
      actor: 'user',
      taskId: this.task.id,
      sessionId: this.session.id,
      payload: {
        actionInFlight: this.currentActionId,
        note: this.currentActionId
          ? 'An action is still in flight. The agent stops writing after it returns.'
          : 'Agent writes stopped.',
      },
    });
    if (!this.currentActionId && !isTerminal(this.task.status)) await this.transition('paused', 'User takeover');
    this.emit('change', this.snapshot());
  }

  async resume(): Promise<void> {
    if (isTerminal(this.task.status) || this.task.status === 'awaiting_user') return;
    if (this.session.lifecycle === 'taken_over') {
      throw new CuaError('CONFLICT', 'The user owns this session. Release control before resuming the agent.');
    }
    this.pauseRequested = false;
    // The existing loop owns the driver throughout a pause. Waking it avoids
    // a second concurrent runLoop when a model call was still returning.
    this.pauseWake?.();
    this.emit('change', this.snapshot());
  }

  private async waitForInflightAction(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.currentActionId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return !this.currentActionId;
  }

  async release(): Promise<void> {
    if (this.task.status === 'paused') {
      this.session = this.store.updateSession({ ...this.session, lifecycle: 'active', ownerId: this.deps.options?.ownerId ?? 'agent' });
      this.store.appendEvent({
        type: 'session.released', actor: 'user', taskId: this.task.id, sessionId: this.session.id,
        payload: { note: 'Control returned to the agent; the agent will re-observe before writing.' },
      });
      this.pauseRequested = false;
      this.pauseWake?.();
    }
  }

  submitUserInput(input: UserInput): boolean {
    if (this.pendingApproval) {
      const approved = input.kind === 'approval' && /^(approve|approved|yes|ok|allow)$/i.test(input.text.trim());
      const pending = this.pendingApproval;
      this.pendingApproval = undefined;
      this.store.appendEvent({
        type: 'user.input',
        actor: 'user',
        taskId: this.task.id,
        sessionId: this.session.id,
        actionId: pending.proposal.id,
        payload: { kind: input.kind, approved },
      });
      pending.resolve(approved);
      this.emit('change', this.snapshot());
      return true;
    }
    if (this.pendingInput) {
      const pending = this.pendingInput;
      this.pendingInput = undefined;
      this.store.appendEvent({
        type: 'user.input',
        actor: 'user',
        taskId: this.task.id,
        sessionId: this.session.id,
        payload: { kind: input.kind, textLength: input.text.length },
      });
      pending.resolve(input);
      this.emit('change', this.snapshot());
      return true;
    }
    return false;
  }

  private async runLoop(): Promise<void> {
    try {
      await this.driver.start();
      this.session = this.store.updateSession({ ...this.session, lifecycle: 'active', capabilities: this.driver.capabilities() });
      if (this.task.status === 'created' || this.task.status === 'paused' || this.task.status === 'needs_attention') {
        await this.transition('observing', 'Task started');
      }
      this.store.appendEvent({
        type: 'task.started',
        actor: 'controller',
        taskId: this.task.id,
        runId: this.task.runId,
        sessionId: this.session.id,
        payload: { driver: this.driver.kind, capabilities: this.driver.capabilities() },
      });

      while (!isTerminal(this.task.status)) {
        if (this.cancelRequested) {
          await this.finalize('cancelled', 'Cancellation requested.');
          break;
        }
        if (this.pauseRequested) {
          if (this.task.status !== 'paused') await this.transition('paused', 'Paused between actions.');
          await new Promise<void>((resolve) => {
            this.pauseWake = resolve;
            if (!this.pauseRequested || this.cancelRequested) resolve();
          });
          this.pauseWake = undefined;
          if (!this.cancelRequested && !this.pauseRequested) await this.transition('observing', 'Resumed; obtaining fresh observation.');
          continue;
        }
        if (this.task.status === 'awaiting_user') {
          // The API resolves this promise through submitUserInput; do not spin.
          await this.waitForUser();
          if (this.cancelRequested) continue;
        }
        this.budget.assertTime();
        if (this.step >= this.task.budgets.maxSteps + 5) {
          await this.finalize('failed', 'Step budget was exhausted before acceptance passed.');
          break;
        }
        if (this.task.status !== 'observing' && this.task.status !== 'planning') {
          if (this.task.status === 'executing' || this.task.status === 'verifying_action') {
            await this.transition('observing', 'Recovered to observation');
          } else {
            break;
          }
        }
        await this.observeStep();
        if (this.pauseRequested) {
          await this.transition('paused', 'Paused after observation.');
          continue;
        }
        if (this.cancelRequested) continue;

        await this.transition('planning', 'Observation ready; asking planner');
        const planningEpoch = this.controlEpoch;
        const decision = await this.plan();
        if (!decision) {
          if (isTerminal(this.task.status) || (this.task.status as TaskStatus) === 'needs_attention') break;
          continue;
        }
        if (this.cancelRequested) continue;
        if (this.pauseRequested || planningEpoch !== this.controlEpoch) {
          if (this.pauseRequested) await this.transition('paused', 'Paused after planning; no new action was started.');
          else await this.transition('observing', 'Control changed while planning; discarding decision and re-observing.');
          continue;
        }

        if (decision.kind === 'ask_user') {
          this.messages.push(decision.assistantMessage);
          this.pushToolResult(decision.assistantMessage, 'Question sent to the user. Execution is paused until a response.');
          await this.transition('awaiting_user', 'Planner requested user input.');
          const input = await this.waitForUser(decision.question);
          if (!input) {
            if (this.cancelRequested) continue;
            await this.finalize('needs_attention', 'The user did not respond before the input timeout.');
            break;
          }
          this.messages.push({ role: 'user', content: `User response: ${input.text}` });
          await this.transition('observing', 'User responded; re-observing');
          continue;
        }

        if (decision.kind === 'error') {
          this.messages.push(decision.assistantMessage);
          this.pushToolResult(decision.assistantMessage, `The tool call was rejected before execution: ${decision.message}\nRe-observe and try a valid action.`);
          this.store.appendEvent({
            type: 'action.denied',
            actor: 'planner',
            taskId: this.task.id,
            sessionId: this.session.id,
            payload: { message: decision.message },
          });
          if (++this.identicalCount > this.options.maxIdenticalActions * 3) {
            await this.finalize('failed', 'Planner produced repeated invalid actions.');
            break;
          }
          await this.transition('observing', 'Planner error; re-observe');
          continue;
        }

        if (decision.kind === 'finish') {
          this.messages.push(decision.assistantMessage);
          this.messages.push({
            role: 'tool',
            toolCallId: decision.assistantMessage.toolCalls?.[0]?.id ?? 'finish',
            content: 'Completion proposed. The runtime will now verify the fixed user acceptance criteria; this is not yet success.',
          });
          const accepted = await this.tryFinish(decision.suggestedChecks, decision.summary);
          if (accepted) break;
          this.finishAttempts += 1;
          this.messages.push({
            role: 'user',
            content:
              'The completion check did not pass. Continue working based on a fresh observation. Do not repeat the same action; use the verification details in the event log.',
          });
          await this.transition('observing', 'Completion proposed but acceptance did not pass');
          continue;
        }

        const proposal = this.buildProposal(decision, this.lastObservation!);
        const retryKey = this.actionKey(proposal);
        const priorFailures = this.failedActions.get(retryKey) ?? 0;
        if (priorFailures > this.task.budgets.maxRetriesPerAction) {
          this.store.appendEvent({ type: 'action.denied', actor: 'controller', taskId: this.task.id, sessionId: this.session.id,
            payload: { reason: 'retry-budget-exhausted', signature: retryKey, failures: priorFailures, maxRetriesPerAction: this.task.budgets.maxRetriesPerAction } });
          await this.finalize('failed', `Retry budget exhausted for the same semantic action after ${priorFailures} failed attempts.`);
          break;
        }
        // Keep the assistant tool call in the conversation exactly once. The
        // matching tool result is added after approval/execution.
        this.messages.push(decision.assistantMessage);
        if (decision.requiresApproval) {
          const approved = await this.requestApproval(proposal);
          if (!approved) {
            this.pushToolResult(decision.assistantMessage, 'The user declined this action. Choose a different approach or ask a question.');
            await this.transition('observing', 'Action declined by user');
            continue;
          }
        }

        if (this.cancelRequested || this.pauseRequested) {
          this.pushToolResult(decision.assistantMessage, 'Control changed before execution; the action was not started.');
          if (this.task.status !== 'observing') await this.transition('observing', 'Re-observe after control change.');
          continue;
        }
        if (priorFailures > 0) this.budget.addRetry();
        await this.transition('executing', `Executing ${proposal.action.tool}`);
        this.currentActionId = proposal.id;
        this.emit('change', this.snapshot());
        let output;
        try {
          output = await this.executor.execute({
            task: this.task,
            observation: this.lastObservation!,
            proposal,
            driver: this.driver,
            budget: this.budget,
            cancellation: this.cancellation,
            approved: decision.requiresApproval || this.task.metadata.autoApproveCode === true,
          });
        } catch (error) {
          this.currentActionId = undefined;
          if (isCuaError(error) && (error.code === 'CANCELLED' || this.cancelRequested)) {
            await this.finalize('cancelled', 'Cancelled before action execution.');
            break;
          }
          if (isCuaError(error) && error.code === 'APPROVAL_REQUIRED') {
            await this.transition('awaiting_user', 'Approval required');
            continue;
          }
          if (isCuaError(error) && error.code === 'BUDGET_EXCEEDED') {
            await this.finalize('failed', error.message);
            break;
          }
          if (isCuaError(error) && error.code === 'UNKNOWN_OUTCOME') {
            await this.finalize('needs_attention', error.message);
            break;
          }
          this.failedActions.set(retryKey, priorFailures + 1);
          this.store.appendEvent({
            type: 'action.denied',
            actor: 'executor',
            taskId: this.task.id,
            sessionId: this.session.id,
            payload: { error: isCuaError(error) ? error.code : 'INTERNAL', message: String(error) },
          });
          this.pushToolResult(
            decision.assistantMessage,
            `The action was rejected before execution: ${isCuaError(error) ? error.code : 'INTERNAL'} ${error instanceof Error ? error.message : String(error)}. Re-observe before trying again.`,
          );
          await this.transition('observing', 'Action rejected before execution');
          continue;
        }
        this.currentActionId = undefined;
        this.step += 1;
        this.lastActionResult = {
          tool: proposal.action.tool,
          status: output.result.status,
          ...(output.result.error ? { error: output.result.error.code } : {}),
          ...(output.result.actual.verificationVerdict
            ? { verification: String(output.result.actual.verificationVerdict) }
            : {}),
        };
        this.pushToolResult(decision.assistantMessage, JSON.stringify({
            status: output.result.status,
            returned: output.result.returned,
            sideEffectUnknown: output.result.sideEffectUnknown,
            error: output.result.error,
            actual: output.result.actual,
            actionId: proposal.id,
          }));
        this.store.saveCheckpoint(this.task.id, this.task.runId, 'after-action', {
          messages: this.messages,
          step: this.step,
          finishAttempts: this.finishAttempts,
          lastActionResult: this.lastActionResult,
          failedActions: Object.fromEntries(this.failedActions),
        });

        if (output.result.status === 'unknown' || output.result.sideEffectUnknown) {
          await this.reconcileUnknown(output.result.actionId);
          break;
        }
        if (output.result.status === 'failed' || output.result.status === 'partial') {
          this.failedActions.set(retryKey, priorFailures + 1);
          if (await this.handleFailure(proposal, output.result.error?.code)) break;
        } else if (this.detectRepeat(proposal)) {
          this.store.appendEvent({
            type: 'monitor.alert',
            actor: 'monitor',
            taskId: this.task.id,
            sessionId: this.session.id,
            payload: { reason: 'identical-action', signature: actionSignature(proposal.action), count: this.identicalCount },
          });
          await this.finalize('needs_attention', 'The same action was repeated without meaningful progress.');
          break;
        }
        if (this.cancelRequested) continue;
        await this.transition('verifying_action', `Action ${output.result.status}; recording evidence`);
        await this.transition('observing', `Action ${output.result.status}; re-observing`);
        if (this.pauseRequested) {
          await this.transition('paused', 'Paused after accounting for the in-flight action.');
          continue;
        }
      }
    } catch (error) {
      await this.onFatal(error);
    } finally {
      this.store.saveCheckpoint(this.task.id, this.task.runId, 'run-ended', {
        messages: this.messages,
        step: this.step,
        finishAttempts: this.finishAttempts,
        status: this.task.status,
        failedActions: Object.fromEntries(this.failedActions),
        budget: this.budget.snapshot(),
      });
      this.emit('change', this.snapshot());
      if (this.options.closeOnFinish && isTerminal(this.task.status)) {
        await this.driver.close().catch(() => undefined);
        await this.executor.close().catch(() => undefined);
        this.session = this.store.updateSession({ ...this.session, lifecycle: 'closed' });
      }
      this.settled = true;
    }
  }

  private async observeStep(): Promise<void> {
    const observation = await this.driver.observe();
    this.store.saveObservation(observation);
    this.lastObservation = observation;
    // Keep the task version moving with its latest observation without
    // changing its status.
    this.task = this.store.updateTask({ ...this.task, lastObservationId: observation.id });
    this.emit('change', this.snapshot());
  }

  private async plan(): Promise<PlannerDecision | undefined> {
    try {
      const compaction = compactMessages(this.messages, 60_000);
      if (compaction.compacted) {
        this.messages = compaction.messages;
        this.store.appendEvent({
          type: 'monitor.note',
          actor: 'controller',
          taskId: this.task.id,
          sessionId: this.session.id,
          payload: {
            reason: 'context-compacted',
            omitted: compaction.omitted,
            beforeChars: compaction.beforeChars,
            afterChars: compaction.afterChars,
            note: 'Older messages remain in the append-only event log; page state must be re-observed.',
          },
        });
      }
      this.budget.assertTime();
      this.budget.addModelCall();
      this.store.appendEvent({
        type: 'model.request', actor: 'planner', taskId: this.task.id, runId: this.task.runId, sessionId: this.session.id,
        payload: { call: this.budget.snapshot().modelCalls, observationId: this.lastObservation!.id },
      });
      const planAbort = new AbortController();
      const offCancel = this.cancellation.onCancel(() => planAbort.abort());
      let decision: PlannerDecision;
      try {
        decision = await this.planner.decide({
          signal: planAbort.signal,
          task: this.task,
          observation: this.lastObservation!,
          messages: this.messages,
          driverKind: this.driver.kind === 'desktop' ? 'desktop' : 'browser',
          driverCapabilities: {
            code: this.task.authorization.allowCode,
            images: this.planner.capabilities().images,
            desktop: this.driver.kind === 'desktop',
            browser: this.driver.kind === 'browser',
          },
          step: this.step,
          budget: {
            maxSteps: this.task.budgets.maxSteps,
            maxModelCalls: this.task.budgets.maxModelCalls,
            maxCostUsd: this.task.budgets.maxCostUsd,
          },
          finishAttempts: this.finishAttempts,
          lastActionResult: this.lastActionResult,
        });
      } finally { offCancel(); }
      this.modelErrorCount = 0;
      this.budget.addModelUsage(decision.usage.inputTokens, decision.usage.outputTokens, decision.usage.costUsd ?? 0);
      this.store.appendEvent({
        type: 'model.response',
        actor: 'planner',
        taskId: this.task.id,
        runId: this.task.runId,
        sessionId: this.session.id,
        payload: {
          kind: decision.kind,
          usage: decision.usage,
          toolName: decision.kind === 'action' ? decision.toolName : undefined,
          summary: decision.kind === 'finish' ? decision.summary : undefined,
        },
      });
      return decision;
    } catch (error) {
      if (this.cancelRequested) return undefined;
      const cua = isCuaError(error) ? error : new CuaError('MODEL_ERROR', String(error), { cause: error });
      this.store.appendEvent({
        type: 'model.error',
        actor: 'planner',
        taskId: this.task.id,
        runId: this.task.runId,
        sessionId: this.session.id,
        payload: { code: cua.code, message: cua.message, retryable: cua.retryable },
      });
      if (cua.code === 'BUDGET_EXCEEDED') {
        await this.finalize('failed', cua.message);
        return undefined;
      }
      if (cua.code === 'MODEL_CAPABILITY_MISSING') {
        await this.finalize('needs_attention', cua.message);
        return undefined;
      }
      this.modelErrorCount += 1;
      if (this.modelErrorCount >= 3) {
        await this.finalize(
          this.lastFinishVerdict === 'fail' ? 'failed' : 'needs_attention',
          `Repeated model errors (${cua.code}); stopping instead of looping without progress. Last acceptance verdict: ${this.lastFinishVerdict ?? 'not run'}.`,
        );
        return undefined;
      }
      this.messages.push({
        role: 'user',
        content: `The planner/model call failed (${cua.code}): ${cua.message}. Re-observe and continue if safe.`,
      });
      await this.transition('observing', 'Model error; re-observing');
      return undefined;
    }
  }

  private buildProposal(decision: Extract<PlannerDecision, { kind: 'action' }>, observation: Observation): ActionProposal {
    const proposal = ActionProposalSchema.parse({
      schemaVersion: 1,
      id: newId('act'),
      taskId: this.task.id,
      runId: this.task.runId,
      sessionId: this.session.id,
      observationId: observation.id,
      surfaceId: observation.surfaceId,
      generation: observation.generation,
      action: decision.action,
      expected: decision.expected,
      risk: decision.risk,
      requiresApproval: decision.requiresApproval,
      rationale: decision.rationale,
      createdAt: nowIso(),
      attempts: 0,
    });
    if (decision.targetId) {
      proposal.targetRef = {
        observationId: observation.id,
        generation: observation.generation,
        targetId: decision.targetId,
        frameId: observation.targets.find((t) => t.targetId === decision.targetId)?.frameId ?? 'main',
        surfaceId: observation.surfaceId,
      };
    }
    return proposal;
  }

  private async requestApproval(proposal: ActionProposal): Promise<boolean> {
    await this.transition('awaiting_user', 'Action requires user approval.');
    return new Promise<boolean>((resolve) => {
      this.pendingApproval = { proposal, resolve };
      this.emit('change', this.snapshot());
      const timer = setTimeout(() => {
        if (this.pendingApproval?.proposal.id === proposal.id) {
          this.pendingApproval = undefined;
          resolve(false);
        }
      }, this.options.userInputTimeoutMs);
      timer.unref?.();
    });
  }

  private pushToolResult(message: ModelMessage, content: string): void {
    const toolCallId = message.toolCalls?.[0]?.id;
    if (toolCallId) {
      this.messages.push({ role: 'tool', toolCallId, content });
    } else {
      this.messages.push({ role: 'user', content });
    }
  }

  private waitForUser(question = 'Waiting for user input.'): Promise<UserInput | undefined> {
    if (this.pendingInput) return Promise.resolve(undefined);
    if (this.cancelRequested) return Promise.resolve(undefined);
    return new Promise<UserInput | undefined>((resolve) => {
      this.pendingInput = { resolve, question };
      this.emit('change', this.snapshot());
      const timer = setTimeout(() => {
        if (this.pendingInput?.resolve === resolve) {
          this.pendingInput = undefined;
          resolve(undefined);
        }
      }, this.options.userInputTimeoutMs);
      timer.unref?.();
    });
  }

  private actionKey(proposal: ActionProposal): string {
    return semanticActionSignature(proposal.action, this.lastObservation!, this.task.metadata.businessObject);
  }

  private detectRepeat(proposal: ActionProposal): boolean {
    const signature = this.actionKey(proposal);
    if (signature === this.lastSignature) this.identicalCount += 1;
    else {
      this.lastSignature = signature;
      this.identicalCount = 1;
    }
    return this.identicalCount >= this.options.maxIdenticalActions;
  }

  private async handleFailure(proposal: ActionProposal, code?: string): Promise<boolean> {
    // Re-observation is mandatory; failures are not retried blindly.
    this.store.appendEvent({
      type: 'monitor.note',
      actor: 'monitor',
      taskId: this.task.id,
      sessionId: this.session.id,
      actionId: proposal.id,
      payload: { reason: 'action-failed', code, note: 'The loop will re-observe before another attempt.' },
    });
    this.messages.push({
      role: 'user',
      content: `The action failed (${code ?? 'unknown'}). Re-observe the current state before trying anything else. Do not assume the action had no effect.`,
    });
    if (this.step >= this.task.budgets.maxSteps) {
      await this.finalize('failed', 'Step budget exhausted after action failures.');
      return true;
    }
    return false;
  }

  private async tryFinish(suggestedChecks: Condition[], summary: string): Promise<boolean> {
    await this.transition('verifying', 'Independently verifying user acceptance criteria.');
    try {
      const verification = await this.verifier.verify({
        task: this.task,
        criteria: this.task.acceptance,
        scope: 'task',
        driver: this.driver,
        waitMs: 8_000,
      });
      this.store.saveVerification(verification);
      if (verification.verdict === 'pass') {
        let supplemental: Condition[] = [];
        if (suggestedChecks.length > 0) {
          // Extra checks may strengthen acceptance, never replace it.
          const extra = await this.verifier.verify({
            task: this.task,
            criteria: suggestedChecks,
            scope: 'task',
            driver: this.driver,
            waitMs: 3_000,
          });
          this.store.saveVerification(extra);
          if (extra.verdict !== 'pass') {
            this.store.appendEvent({
              type: 'monitor.alert',
              actor: 'verifier',
              taskId: this.task.id,
              sessionId: this.session.id,
              payload: { reason: 'supplemental-check-failed', verdict: extra.verdict, details: extra.details },
            });
            await this.finalize(
              extra.verdict === 'fail' ? 'failed' : 'needs_attention',
              `User acceptance passed, but a model-suggested check did not (${extra.verdict}).`,
            );
            return true;
          }
          supplemental = suggestedChecks;
        }
        // Capture the final visible state as evidence. Acceptance is already
        // proven by the durable check; this observation is for the console and
        // audit trail, not a second success condition.
        try {
          await this.observeStep();
        } catch {
          // The durable verification remains valid even if a final screenshot
          // cannot be captured.
        }
        this.task = this.store.updateTask({
          ...this.task,
          metadata: { ...this.task.metadata, finishSummary: summary, verificationId: verification.id, supplementalChecks: supplemental },
        });
        await this.finalize('succeeded', 'All user acceptance criteria passed.', verification.id);
        return true;
      }
      this.lastFinishVerdict = verification.verdict;
      if (verification.verdict === 'fail' && this.finishAttempts + 1 < this.options.maxFinishAttempts) {
        this.store.appendEvent({
          type: 'monitor.note',
          actor: 'verifier',
          taskId: this.task.id,
          sessionId: this.session.id,
          payload: { reason: 'finish-rejected', verdict: verification.verdict, details: verification.details },
        });
        return false;
      }
      this.lastFinishVerdict = verification.verdict;
      await this.finalize(
        verification.verdict === 'fail' ? 'failed' : 'needs_attention',
        `Completion was not accepted: ${verification.verdict}. ${verification.missing.join(' | ')}`.trim(),
        verification.id,
      );
      return true;
    } catch (error) {
      const cua = isCuaError(error) ? error : new CuaError('VERIFICATION_FAILED', String(error));
      await this.finalize('needs_attention', `Final verification could not run: ${cua.message}`);
      return true;
    }
  }

  private async reconcileUnknown(actionId: string): Promise<void> {
    const action = this.store.getAction(actionId);
    this.store.appendEvent({
      type: 'task.recovery_required',
      actor: 'controller',
      taskId: this.task.id,
      sessionId: this.session.id,
      actionId,
      payload: {
        reason: 'unknown-action-outcome',
        note: 'No retry will be attempted until the current business state is read read-only.',
      },
    });
    await this.transition('verifying_unknown', 'An action has an unknown outcome; verifying read-only.');
    try {
      const verification = await this.verifier.verify({
        task: this.task,
        criteria: this.task.acceptance,
        scope: 'recovery',
        actionId,
        driver: this.driver,
        waitMs: 5_000,
      });
      this.store.saveVerification(verification);
      this.store.appendEvent({
        type: 'action.reconciled',
        actor: 'verifier',
        taskId: this.task.id,
        sessionId: this.session.id,
        actionId,
        payload: { verdict: verification.verdict, details: verification.details },
      });
      if (verification.verdict === 'pass') {
        this.task = this.store.updateTask({
          ...this.task,
          metadata: { ...this.task.metadata, recoveredActionId: actionId, recoveredVerdict: 'pass' },
        });
        await this.finalize('succeeded', 'Acceptance passed while reconciling an unknown action outcome.', verification.id);
      } else {
        await this.finalize(
          'needs_attention',
          `An action has an unknown outcome (${action?.proposal.action.tool ?? actionId}); live state was read but acceptance did not pass. No retry was attempted.`,
          verification.id,
        );
      }
    } catch (error) {
      await this.finalize('needs_attention', `Unknown action reconciliation failed: ${String(error)}`);
    }
  }

  private async transition(to: TaskStatus, reason?: string): Promise<void> {
    if (isTerminal(this.task.status)) return;
    if (this.task.status === to) {
      if (reason && reason !== this.task.statusReason) {
        this.task = this.store.updateTask({ ...this.task, statusReason: reason });
      }
      return;
    }
    const from = this.task.status;
    this.task = this.store.updateTask(
      { ...this.task, status: to, statusReason: reason },
      {
        event: {
          type: 'task.status',
          actor: 'controller',
          payload: { from, to, reason, step: this.step },
        },
      },
    );
    this.emit('change', this.snapshot());
  }

  private async finalize(status: 'succeeded' | 'failed' | 'cancelled' | 'needs_attention', reason: string, verificationId?: string): Promise<void> {
    if (isTerminal(this.task.status)) return;
    if (this.task.status === status) return;
    this.task = this.store.updateTask(
      {
        ...this.task,
        status,
        statusReason: reason,
        terminalReason: isTerminal(status) ? reason : this.task.terminalReason,
        ...(verificationId ? { metadata: { ...this.task.metadata, finalVerificationId: verificationId } } : {}),
      },
      {
        event: {
          type:
            status === 'cancelled'
              ? 'task.cancelled'
              : status === 'needs_attention'
                ? 'task.status'
                : 'task.finished',
          actor: 'controller',
          payload: {
            status,
            reason,
            verificationId,
            actionInFlight: this.currentActionId,
            elapsedMs: Date.now() - this.startedAt,
            budget: this.budget.snapshot(),
          },
        },
      },
    );
    this.emit('change', this.snapshot());
  }

  private async onFatal(error: unknown): Promise<void> {
    const cua = isCuaError(error) ? error : new CuaError('INTERNAL', error instanceof Error ? error.message : String(error), { cause: error });
    this.store.appendEvent({
      type: 'model.error',
      actor: 'controller',
      taskId: this.task.id,
      sessionId: this.session.id,
      payload: { fatal: true, code: cua.code, message: cua.message },
    });
    if (this.task.status === 'executing' && this.currentActionId) {
      // An action was in flight when the controller died. The action record is
      // left as 'intent' on purpose; recovery will mark it UNKNOWN and verify.
      this.store.saveCheckpoint(this.task.id, this.task.runId, 'fatal-with-action-in-flight', {
        actionId: this.currentActionId,
        note: 'Do not retry. Recovery must read current business state first.',
      });
      if (!isTerminal(this.task.status)) {
        try {
          await this.transition('verifying_unknown', `Fatal error while action ${this.currentActionId} was in flight: ${cua.message}`);
        } catch {
          // Preserve the original task state if transition is not allowed.
        }
      }
      return;
    }
    await this.finalize('failed', `Fatal controller error: ${cua.message}`);
  }
}
