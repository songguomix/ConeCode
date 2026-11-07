import { createHash } from 'node:crypto';
import type { SessionStore, WorkflowRecord } from '../store/store.js';
import type { ActionProposal, Task } from '../protocol/schemas.js';
import { redact, redactString } from '../protocol/redact.js';

interface StableStep {
  tool: string;
  target?: { role: string; name: string };
  value?: string;
  url?: string;
  direction?: string;
  amount?: number;
}

export interface WorkflowHint {
  name: string;
  version: number;
  steps: StableStep[];
  lastVerifiedAt?: string;
  note: string;
}

/**
 * Long-term memory for VERIFIED workflows only. It stores semantic steps and
 * acceptance criteria; target ids, coordinates, screenshots and old page state
 * are deliberately excluded. Reuse is a planning hint, never an execution
 * shortcut: every action still needs a fresh observation and authorization.
 */
export class WorkflowMemory {
  constructor(
    private readonly store: SessionStore,
    private readonly options: { maxAgeMs?: number } = {},
  ) {
    // Migrate legacy values before any API listing or planner hint can expose
    // them. Sanitization is not a new verification of the workflow.
    for (const record of this.store.listWorkflows()) this.safeRecord(record);
  }

  keyFor(task: Task): string {
    if (typeof task.metadata.workflowKey === 'string' && task.metadata.workflowKey.trim()) {
      return safeWorkflowName(task.metadata.workflowKey.trim());
    }
    return `wf_${hash(JSON.stringify({ goal: task.goal, acceptance: task.acceptance, environment: task.environment.kind }))}`;
  }

  learn(task: Task): WorkflowRecord | undefined {
    if (task.status !== 'succeeded') return undefined;
    const actions = this.store.listActions(task.id);
    if (actions.length === 0) return undefined;
    if (actions.some((a) => a.result?.status !== 'succeeded')) return undefined;
    const steps: StableStep[] = [];
    for (const action of actions) {
      const stable = this.toStableStep(action.proposal);
      if (stable) steps.push(stable);
    }
    if (steps.length === 0) return undefined;
    const name = this.keyFor(task);
    const existing = this.store.getWorkflow(name);
    const record = this.store.upsertWorkflow(name, sanitizeWorkflowData({
      goal: task.goal,
      driverKind: task.environment.kind,
      acceptance: task.acceptance,
      steps,
      learnedFromTask: task.id,
      schemaVersion: 1,
    }));
    this.store.appendEvent({
      type: 'workflow.learned',
      actor: 'system',
      taskId: task.id,
      payload: { name, version: record.version, stepCount: steps.length, replacedVersion: existing?.version },
    });
    return record;
  }

  lookup(task: Task): WorkflowHint | undefined {
    const stored = this.store.getWorkflow(this.keyFor(task));
    const record = stored ? this.safeRecord(stored) : undefined;
    if (!record || record.invalidatedAt) return undefined;
    const lastVerified = record.lastVerifiedAt ? Date.parse(record.lastVerifiedAt) : 0;
    if (!Number.isFinite(lastVerified) || Date.now() - lastVerified > (this.options.maxAgeMs ?? 7 * 24 * 60 * 60_000)) {
      this.store.invalidateWorkflow(record.name);
      this.store.appendEvent({
        type: 'workflow.invalidated',
        actor: 'system',
        taskId: task.id,
        payload: { name: record.name, reason: 'expired' },
      });
      return undefined;
    }
    return {
      name: record.name,
      version: record.version,
      steps: Array.isArray(record.data.steps) ? (record.data.steps as StableStep[]).slice(0, 20) : [],
      lastVerifiedAt: record.lastVerifiedAt,
      note: 'This is a previously verified plan shape, not permission or proof of the current page. Re-observe and revalidate every target; never reuse IDs, coordinates or old page state.',
    };
  }

  invalidate(task: Task, reason = 'manual'): void {
    const name = this.keyFor(task);
    this.store.invalidateWorkflow(name);
    this.store.appendEvent({ type: 'workflow.invalidated', actor: 'system', taskId: task.id, payload: { name, reason } });
  }

  list(): WorkflowRecord[] {
    return this.store.listWorkflows().map((record) => this.safeRecord(record));
  }

  delete(name: string): boolean {
    return this.store.deleteWorkflow(name);
  }

  private safeRecord(record: WorkflowRecord): WorkflowRecord {
    const data = sanitizeWorkflowData(record.data);
    const name = safeWorkflowName(record.name);
    if (JSON.stringify(data) !== JSON.stringify(record.data) || name !== record.name) {
      return this.store.sanitizeWorkflow(record.name, data, name);
    }
    return record;
  }

  private toStableStep(proposal: ActionProposal): StableStep | undefined {
    const action = proposal.action;
    if (action.tool === 'task.finish' || action.tool === 'code.run') return undefined;
    if (action.tool === 'browser.observe' || action.tool === 'browser.screenshot' || action.tool === 'desktop.screenshot') return undefined;
    const step: StableStep = { tool: action.tool };
    if ('targetId' in action && typeof action.targetId === 'string') {
      const observation = this.store.getObservation(proposal.observationId);
      const target = observation?.targets.find((t) => t.targetId === action.targetId);
      if (target) step.target = { role: target.role, name: target.name };
    }
    if (action.tool === 'browser.fill') {
      const observation = this.store.getObservation(proposal.observationId);
      const target = observation?.targets.find((t) => t.targetId === action.targetId);
      if (target?.type !== 'password') step.value = redactString(action.value).slice(0, 500);
    }
    if (action.tool === 'browser.navigate' || action.tool === 'browser.open_tab') step.url = action.url;
    if ('direction' in action && typeof action.direction === 'string') step.direction = action.direction;
    if ('amount' in action && typeof action.amount === 'number') step.amount = action.amount;
    return step;
  }
}

/** Pattern-based redaction plus conservative removal of URL credentials/query. */
function sanitizeWorkflowData(data: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return sanitizeString(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  return redact(visit(data)) as Record<string, unknown>;
}

function sanitizeString(value: string): string {
  const withoutUrlSecrets = value.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
    try {
      const url = new URL(raw);
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      return url.href;
    } catch { return '[invalid-url-omitted]'; }
  });
  return redactString(withoutUrlSecrets);
}

function safeWorkflowName(name: string): string {
  return sanitizeString(name) === name ? name : `wf_${hash(name)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export type { StableStep };
