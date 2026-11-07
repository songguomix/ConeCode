import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId } from '../protocol/ids.js';
import { CuaError } from '../protocol/errors.js';
import { redact, redactString } from '../protocol/redact.js';
import {
  ActionProposalSchema,
  ExecutionResultSchema,
  ObservationSchema,
  SessionSchema,
  TaskSchema,
  VerificationResultSchema,
  nowIso,
  type ActionProposal,
  type Event,
  type EventType,
  type ExecutionResult,
  type Observation,
  type Session,
  type Task,
  type TaskStatus,
  type VerificationResult,
} from '../protocol/schemas.js';
import { assertTransition } from '../protocol/transitions.js';

export interface EventInput {
  type: EventType;
  actor: Event['actor'];
  taskId?: string;
  runId?: string;
  sessionId?: string;
  observationId?: string;
  actionId?: string;
  correlationId?: string;
  payload?: Record<string, unknown>;
  at?: string;
}

export interface StoredAction {
  id: string;
  proposal: ActionProposal;
  result?: ExecutionResult;
  status: 'intent' | 'running' | 'finished' | 'unknown';
  startedAt: string;
  endedAt?: string;
}

export interface Lease {
  sessionId: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: string;
}

export interface ArtifactRecord {
  id: string;
  taskId?: string;
  kind: string;
  path: string;
  sha256?: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  version: number;
  data: Record<string, unknown>;
  lastVerifiedAt?: string;
  invalidatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * SQLite source of truth plus an append-only event log. Every business write
 * that matters (task state, action intent/result, verification, observations)
 * is committed in its own transaction and is also represented as an event.
 * SQLite's WAL mode lets a separate read-only monitor tail events safely.
 */
export class SessionStore {
  readonly db: DatabaseSync;
  private closed = false;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    // Tighten an existing database before enabling WAL: sidecars normally
    // inherit the main database's mode. Do not chmod caller-owned parent dirs.
    if (path !== ':memory:') {
      chmodSync(path, 0o600);
      for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
    }
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      ${path === ':memory:' ? '' : 'PRAGMA journal_mode = WAL;'}
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        at TEXT NOT NULL,
        screenshot_path TEXT,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_obs_task_at ON observations(task_id, at DESC);
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        observation_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        status TEXT NOT NULL,
        intent TEXT NOT NULL,
        result TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_actions_task ON actions(task_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS verifications (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        action_id TEXT,
        verdict TEXT NOT NULL,
        at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ver_task ON verifications(task_id, at DESC);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        task_id TEXT,
        session_id TEXT,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events(task_id, seq);
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        at TEXT NOT NULL,
        reason TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ckpt_task ON checkpoints(task_id, at DESC);
      CREATE TABLE IF NOT EXISTS leases (
        session_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT,
        meta TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        last_verified_at TEXT,
        invalidated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    if (path !== ':memory:') {
      for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw error;
    }
  }

  // ---- tasks ---------------------------------------------------------------

  createTask(task: Task, event?: Omit<EventInput, 'taskId' | 'runId'>): Task {
    const validated = TaskSchema.parse(task);
    return this.tx(() => {
      this.db
        .prepare('INSERT INTO tasks (id, run_id, status, version, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(validated.id, validated.runId, validated.status, validated.version, validated.updatedAt, JSON.stringify(validated));
      if (event) this.appendEvent({ ...event, taskId: validated.id, runId: validated.runId });
      return validated;
    });
  }

  updateTask(task: Task, options: { expectedVersion?: number; event?: Omit<EventInput, 'taskId' | 'runId'> } = {}): Task {
    const validated = TaskSchema.parse(task);
    return this.tx(() => {
      const row = this.db.prepare('SELECT version, status FROM tasks WHERE id = ?').get(validated.id) as
        | { version: number; status: string }
        | undefined;
      if (!row) throw new CuaError('TASK_NOT_FOUND', `Task ${validated.id} does not exist.`);
      if (options.expectedVersion !== undefined && row.version !== options.expectedVersion) {
        throw new CuaError('CONFLICT', `Task ${validated.id} was updated by another writer.`, {
          details: { expected: options.expectedVersion, actual: row.version },
        });
      }
      const from = row.status as TaskStatus;
      if (from !== validated.status) assertTransition(from, validated.status);
      const version = row.version + 1;
      const next = { ...validated, version, updatedAt: nowIso() };
      this.db
        .prepare('UPDATE tasks SET status = ?, version = ?, updated_at = ?, data = ? WHERE id = ? AND version = ?')
        .run(next.status, version, next.updatedAt, JSON.stringify(next), next.id, row.version);
      if (options.event) this.appendEvent({ ...options.event, taskId: next.id, runId: next.runId });
      return next;
    });
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? TaskSchema.parse(JSON.parse(row.data)) : undefined;
  }

  requireTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new CuaError('TASK_NOT_FOUND', `Task ${id} does not exist.`);
    return task;
  }

  listTasks(limit = 50): Task[] {
    const rows = this.db.prepare('SELECT data FROM tasks ORDER BY updated_at DESC LIMIT ?').all(limit) as Array<{
      data: string;
    }>;
    return rows.map((r) => TaskSchema.parse(JSON.parse(r.data)));
  }

  listRecoverableTasks(): Task[] {
    const rows = this.db
      .prepare(
        "SELECT data FROM tasks WHERE status NOT IN ('succeeded','failed','cancelled') ORDER BY updated_at ASC",
      )
      .all() as Array<{ data: string }>;
    return rows.map((r) => TaskSchema.parse(JSON.parse(r.data)));
  }

  // ---- sessions ------------------------------------------------------------

  createSession(session: Session): Session {
    const validated = SessionSchema.parse(session);
    this.tx(() => {
      this.db
        .prepare(
          'INSERT INTO sessions (id, task_id, lifecycle, owner_id, fencing_token, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          validated.id,
          validated.taskId,
          validated.lifecycle,
          validated.ownerId,
          validated.fencingToken,
          validated.updatedAt,
          JSON.stringify(validated),
        );
      this.appendEvent({
        type: 'session.created',
        actor: 'controller',
        taskId: validated.taskId,
        runId: validated.runId,
        sessionId: validated.id,
        payload: { kind: validated.kind, ownerId: validated.ownerId },
      });
    });
    return validated;
  }

  updateSession(session: Session): Session {
    const validated = { ...SessionSchema.parse(session), updatedAt: nowIso() };
    this.db
      .prepare('UPDATE sessions SET lifecycle = ?, owner_id = ?, fencing_token = ?, updated_at = ?, data = ? WHERE id = ?')
      .run(
        validated.lifecycle,
        validated.ownerId,
        validated.fencingToken,
        validated.updatedAt,
        JSON.stringify(validated),
        validated.id,
      );
    return validated;
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? SessionSchema.parse(JSON.parse(row.data)) : undefined;
  }

  listSessions(taskId: string): Session[] {
    const rows = this.db.prepare('SELECT data FROM sessions WHERE task_id = ?').all(taskId) as Array<{ data: string }>;
    return rows.map((r) => SessionSchema.parse(JSON.parse(r.data)));
  }

  // ---- observations --------------------------------------------------------

  saveObservation(observation: Observation): Observation {
    const validated = ObservationSchema.parse(observation);
    this.tx(() => {
      this.db
        .prepare(
          'INSERT INTO observations (id, task_id, session_id, generation, at, screenshot_path, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          validated.id,
          validated.taskId,
          validated.sessionId,
          validated.generation,
          validated.at,
          validated.screenshot?.path ?? null,
          JSON.stringify(validated),
        );
      this.appendEvent({
        type: 'observation.captured',
        actor: 'controller',
        taskId: validated.taskId,
        runId: validated.runId,
        sessionId: validated.sessionId,
        observationId: validated.id,
        payload: {
          generation: validated.generation,
          targetCount: validated.targets.length,
          coverage: validated.coverage,
          screenshot: validated.screenshot?.artifactId,
        },
      });
    });
    return validated;
  }

  getObservation(id: string): Observation | undefined {
    const row = this.db.prepare('SELECT data FROM observations WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? ObservationSchema.parse(JSON.parse(row.data)) : undefined;
  }

  latestObservation(taskId: string): Observation | undefined {
    const row = this.db
      .prepare('SELECT data FROM observations WHERE task_id = ? ORDER BY at DESC LIMIT 1')
      .get(taskId) as { data: string } | undefined;
    return row ? ObservationSchema.parse(JSON.parse(row.data)) : undefined;
  }

  // ---- actions -------------------------------------------------------------

  recordActionIntent(proposal: ActionProposal): void {
    const validated = ActionProposalSchema.parse(proposal);
    this.tx(() => {
      this.db
        .prepare(
          'INSERT INTO actions (id, task_id, session_id, observation_id, tool, status, intent, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          validated.id,
          validated.taskId,
          validated.sessionId,
          validated.observationId,
          validated.action.tool,
          'intent',
          JSON.stringify(validated),
          validated.createdAt,
        );
      this.appendEvent({
        type: 'action.intent',
        actor: 'executor',
        taskId: validated.taskId,
        runId: validated.runId,
        sessionId: validated.sessionId,
        observationId: validated.observationId,
        actionId: validated.id,
        payload: {
          tool: validated.action.tool,
          action: redact(validated.action),
          expected: validated.expected,
          risk: validated.risk,
          rationale: validated.rationale,
        },
      });
    });
  }

  recordActionResult(result: ExecutionResult): void {
    const validated = ExecutionResultSchema.parse(result);
    this.tx(() => {
      this.db
        .prepare('UPDATE actions SET status = ?, result = ?, ended_at = ? WHERE id = ?')
        .run(
          validated.status === 'unknown' ? 'unknown' : 'finished',
          JSON.stringify(validated),
          validated.endedAt,
          validated.actionId,
        );
      this.appendEvent({
        type: validated.status === 'unknown' ? 'action.unknown' : 'action.result',
        actor: 'executor',
        taskId: validated.taskId,
        sessionId: validated.sessionId,
        actionId: validated.actionId,
        payload: {
          status: validated.status,
          returned: validated.returned,
          sideEffectUnknown: validated.sideEffectUnknown,
          actual: redact(validated.actual),
          error: validated.error,
        },
      });
    });
  }

  /** Close an action that was running when the process died. This is the only
   * write allowed during recovery before the live business state is read. */
  markActionUnknown(actionId: string, reason: string): StoredAction {
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as any;
      if (!row) throw new CuaError('PROTOCOL_INVALID', `Action ${actionId} does not exist.`);
      if (row.result) return this.actionFromRow(row);
      const result: ExecutionResult = {
        schemaVersion: 1,
        actionId,
        taskId: row.task_id,
        sessionId: row.session_id,
        status: 'unknown',
        startedAt: row.started_at,
        endedAt: nowIso(),
        returned: false,
        sideEffectUnknown: true,
        actual: { reason },
        evidence: [],
      };
      this.db
        .prepare('UPDATE actions SET status = ?, result = ?, ended_at = ? WHERE id = ?')
        .run('unknown', JSON.stringify(result), result.endedAt, actionId);
      this.appendEvent({
        type: 'action.unknown',
        actor: 'system',
        taskId: row.task_id,
        sessionId: row.session_id,
        actionId,
        payload: { recoveredAtStartup: true, reason },
      });
      return this.actionFromRow(this.db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as any);
    });
  }

  getAction(id: string): StoredAction | undefined {
    const row = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as any;
    return row ? this.actionFromRow(row) : undefined;
  }

  listActions(taskId: string, limit = 100): StoredAction[] {
    const rows = this.db
      .prepare('SELECT * FROM actions WHERE task_id = ? ORDER BY started_at ASC, rowid ASC LIMIT ?')
      .all(taskId, limit) as any[];
    return rows.map((r) => this.actionFromRow(r));
  }

  listPendingActions(taskId: string): StoredAction[] {
    const rows = this.db
      .prepare("SELECT * FROM actions WHERE task_id = ? AND status IN ('intent','running') ORDER BY started_at ASC, rowid ASC")
      .all(taskId) as any[];
    return rows.map((r) => this.actionFromRow(r));
  }

  private actionFromRow(row: any): StoredAction {
    return {
      id: row.id,
      proposal: ActionProposalSchema.parse(JSON.parse(row.intent)),
      result: row.result ? ExecutionResultSchema.parse(JSON.parse(row.result)) : undefined,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
    };
  }

  // ---- verification --------------------------------------------------------

  saveVerification(result: VerificationResult): VerificationResult {
    const validated = VerificationResultSchema.parse(result);
    this.tx(() => {
      this.db
        .prepare('INSERT INTO verifications (id, task_id, action_id, verdict, at, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          validated.id,
          validated.taskId,
          validated.actionId ?? null,
          validated.verdict,
          validated.at,
          JSON.stringify(validated),
        );
      this.appendEvent({
        type: 'verification.result',
        actor: 'verifier',
        taskId: validated.taskId,
        actionId: validated.actionId,
        payload: {
          scope: validated.scope,
          verdict: validated.verdict,
          criteria: validated.criteria,
          missing: validated.missing,
        },
      });
    });
    return validated;
  }

  listVerifications(taskId: string, limit = 100): VerificationResult[] {
    const rows = this.db
      .prepare('SELECT data FROM verifications WHERE task_id = ? ORDER BY at ASC LIMIT ?')
      .all(taskId, limit) as Array<{ data: string }>;
    return rows.map((r) => VerificationResultSchema.parse(JSON.parse(r.data)));
  }

  // ---- events --------------------------------------------------------------

  appendEvent(input: EventInput): Event {
    const at = input.at ?? nowIso();
    const id = newId('evt');
    const payload = redact(input.payload ?? {}) as Record<string, unknown>;
    // A single INSERT is already atomic. Staying out of this.tx() also lets
    // callers append an event inside their own business transaction.
    const res = this.db
      .prepare('INSERT INTO events (id, task_id, session_id, type, at, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        id,
        input.taskId ?? null,
        input.sessionId ?? null,
        input.type,
        at,
        JSON.stringify({
          runId: input.runId,
          observationId: input.observationId,
          actionId: input.actionId,
          correlationId: input.correlationId,
          actor: input.actor,
          payload,
        }),
      );
    const seq = Number(res.lastInsertRowid);
    return {
      schemaVersion: 1,
      seq,
      id,
      type: input.type,
      at,
      taskId: input.taskId,
      runId: input.runId,
      sessionId: input.sessionId,
      observationId: input.observationId,
      actionId: input.actionId,
      correlationId: input.correlationId,
      actor: input.actor,
      payload,
    };
  }

  listEvents(taskId?: string, since = 0, limit = 500): Event[] {
    const rows = taskId
      ? (this.db
          .prepare('SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
          .all(taskId, since, limit) as any[])
      : (this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(since, limit) as any[]);
    return rows.map((row) => {
      const data = JSON.parse(row.data);
      return {
        schemaVersion: 1,
        seq: row.seq,
        id: row.id,
        type: row.type,
        at: row.at,
        taskId: row.task_id ?? undefined,
        sessionId: row.session_id ?? undefined,
        runId: data.runId,
        observationId: data.observationId,
        actionId: data.actionId,
        correlationId: data.correlationId,
        actor: data.actor,
        payload: data.payload,
      } as Event;
    });
  }

  lastEventSeq(taskId?: string): number {
    const row = taskId
      ? (this.db.prepare('SELECT MAX(seq) AS seq FROM events WHERE task_id = ?').get(taskId) as { seq: number | null })
      : (this.db.prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number | null });
    return row?.seq ?? 0;
  }

  // ---- checkpoints ---------------------------------------------------------

  saveCheckpoint(taskId: string, runId: string, reason: string, data: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO checkpoints (id, task_id, run_id, at, reason, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId('ckpt'), taskId, runId, nowIso(), reason, JSON.stringify(data));
  }

  latestCheckpoint(taskId: string): { at: string; reason: string; data: Record<string, unknown> } | undefined {
    const row = this.db
      .prepare('SELECT at, reason, data FROM checkpoints WHERE task_id = ? ORDER BY at DESC LIMIT 1')
      .get(taskId) as { at: string; reason: string; data: string } | undefined;
    return row ? { at: row.at, reason: row.reason, data: JSON.parse(row.data) } : undefined;
  }

  // ---- leases --------------------------------------------------------------

  acquireLease(sessionId: string, ownerId: string, ttlMs = 60_000, now = Date.now()): Lease {
    return this.tx(() => {
      const key = newId('lease');
      const expiresAt = new Date(now + ttlMs).toISOString();
      const existing = this.db.prepare('SELECT * FROM leases WHERE session_id = ?').get(sessionId) as any;
      if (existing && existing.owner_id !== ownerId && new Date(existing.expires_at).getTime() > now) {
        throw new CuaError('CONFLICT', `Session ${sessionId} is owned by ${existing.owner_id}.`, {
          details: { ownerId: existing.owner_id, expiresAt: existing.expires_at },
        });
      }
      const fencingToken = Math.max(existing?.fencing_token ?? 0, Date.now()) + 1;
      void key;
      this.db
        .prepare(
          `INSERT INTO leases (session_id, owner_id, fencing_token, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET owner_id=excluded.owner_id, fencing_token=excluded.fencing_token, expires_at=excluded.expires_at`,
        )
        .run(sessionId, ownerId, fencingToken, expiresAt);
      this.appendEvent({
        type: 'lease.acquired',
        actor: 'controller',
        sessionId,
        payload: { ownerId, fencingToken, expiresAt },
      });
      return { sessionId, ownerId, fencingToken, expiresAt };
    });
  }

  renewLease(sessionId: string, ownerId: string, fencingToken: number, ttlMs = 60_000): Lease {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const res = this.db
      .prepare('UPDATE leases SET expires_at = ? WHERE session_id = ? AND owner_id = ? AND fencing_token = ?')
      .run(expiresAt, sessionId, ownerId, fencingToken);
    if (Number(res.changes) === 0) {
      throw new CuaError('LEASE_LOST', `Lost the execution lease for session ${sessionId}.`, {
        details: { ownerId, fencingToken },
      });
    }
    return { sessionId, ownerId, fencingToken, expiresAt };
  }

  releaseLease(sessionId: string, ownerId: string, fencingToken: number): void {
    this.db
      .prepare('DELETE FROM leases WHERE session_id = ? AND owner_id = ? AND fencing_token = ?')
      .run(sessionId, ownerId, fencingToken);
    this.appendEvent({ type: 'lease.lost', actor: 'controller', sessionId, payload: { ownerId, released: true } });
  }

  getLease(sessionId: string): Lease | undefined {
    const row = this.db.prepare('SELECT * FROM leases WHERE session_id = ?').get(sessionId) as any;
    return row
      ? { sessionId: row.session_id, ownerId: row.owner_id, fencingToken: row.fencing_token, expiresAt: row.expires_at }
      : undefined;
  }

  // ---- artifacts -----------------------------------------------------------

  saveArtifact(record: Omit<ArtifactRecord, 'id' | 'createdAt'>): ArtifactRecord {
    const full: ArtifactRecord = { ...record, id: newId('art'), createdAt: nowIso() };
    this.db
      .prepare('INSERT INTO artifacts (id, task_id, kind, path, sha256, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        full.id,
        full.taskId ?? null,
        full.kind,
        full.path,
        full.sha256 ?? null,
        JSON.stringify(full.meta),
        full.createdAt,
      );
    this.appendEvent({
      type: 'artifact.created',
      actor: 'system',
      taskId: full.taskId,
      payload: { artifactId: full.id, kind: full.kind, path: full.path },
    });
    return full;
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as any;
    return row
      ? {
          id: row.id,
          taskId: row.task_id ?? undefined,
          kind: row.kind,
          path: row.path,
          sha256: row.sha256 ?? undefined,
          meta: JSON.parse(row.meta),
          createdAt: row.created_at,
        }
      : undefined;
  }

  // ---- workflows (long-term memory) ---------------------------------------

  upsertWorkflow(name: string, data: Record<string, unknown>, verifiedAt = nowIso()): WorkflowRecord {
    const existing = this.getWorkflow(name);
    const record: WorkflowRecord = {
      id: existing?.id ?? newId('wf'),
      name,
      version: (existing?.version ?? 0) + 1,
      data,
      lastVerifiedAt: verifiedAt,
      invalidatedAt: undefined,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, version, data, last_verified_at, invalidated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET version=excluded.version, data=excluded.data,
           last_verified_at=excluded.last_verified_at, invalidated_at=excluded.invalidated_at, updated_at=excluded.updated_at`,
      )
      .run(
        record.id,
        record.name,
        record.version,
        JSON.stringify(record.data),
        record.lastVerifiedAt ?? null,
        record.invalidatedAt ?? null,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  getWorkflow(name: string): WorkflowRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workflows WHERE name = ?').get(name) as any;
    return row ? this.workflowFromRow(row) : undefined;
  }

  listWorkflows(): WorkflowRecord[] {
    return (this.db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all() as any[]).map((r) =>
      this.workflowFromRow(r),
    );
  }

  invalidateWorkflow(name: string): void {
    this.db.prepare('UPDATE workflows SET invalidated_at = ?, updated_at = ? WHERE name = ?').run(nowIso(), nowIso(), name);
  }

  /** Privacy-only migration: do not refresh verification time or version. */
  sanitizeWorkflow(name: string, data: Record<string, unknown>, safeName = name): WorkflowRecord {
    this.db.prepare('UPDATE workflows SET name = ?, data = ? WHERE name = ?').run(safeName, JSON.stringify(data), name);
    return this.getWorkflow(safeName)!;
  }

  /** Explicit logical deletion. Historical evidence and backups are retained. */
  deleteWorkflow(name: string): boolean {
    let deleted = false;
    this.tx(() => {
      deleted = Number(this.db.prepare('DELETE FROM workflows WHERE name = ?').run(name).changes) > 0;
      if (deleted) this.appendEvent({ type: 'workflow.deleted', actor: 'user', payload: { name: redactString(name) } });
    });
    return deleted;
  }

  private workflowFromRow(row: any): WorkflowRecord {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      data: JSON.parse(row.data),
      lastVerifiedAt: row.last_verified_at ?? undefined,
      invalidatedAt: row.invalidated_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
