export type ConstraintSessionStatus = 'UNASKED' | 'ENABLED' | 'DECLINED';

export type DetectionSource =
  | 'model_name'
  | 'alias_cache'
  | 'response_fingerprint'
  | 'response_header'
  | 'global_config'
  | 'none';

export interface GptConstraintSessionRecord {
  sessionId: string;
  status: ConstraintSessionStatus;
  detectedModel?: string;
  detectionSource?: DetectionSource;
  updatedAt: number;
}

export class IllegalConstraintStateTransitionError extends Error {
  readonly sessionId: string;
  readonly fromState: ConstraintSessionStatus;
  readonly toState: ConstraintSessionStatus;

  constructor(sessionId: string, fromState: ConstraintSessionStatus, toState: ConstraintSessionStatus) {
    super(
      `Illegal GPT constraint state transition for session "${sessionId}": ${fromState} -> ${toState}`,
    );
    this.name = 'IllegalConstraintStateTransitionError';
    this.sessionId = sessionId;
    this.fromState = fromState;
    this.toState = toState;
  }
}

export class ConstraintStateCorruptedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`GPT constraint session state corrupted: ${message}`);
    this.name = 'ConstraintStateCorruptedError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

const VALID_STATUSES = new Set<ConstraintSessionStatus>(['UNASKED', 'ENABLED', 'DECLINED']);

const ALLOWED_TRANSITIONS: Record<ConstraintSessionStatus, ReadonlySet<ConstraintSessionStatus>> = {
  UNASKED: new Set<ConstraintSessionStatus>(['UNASKED', 'ENABLED', 'DECLINED']),
  ENABLED: new Set<ConstraintSessionStatus>(['ENABLED']),
  DECLINED: new Set<ConstraintSessionStatus>(['DECLINED']),
};

export interface ConstraintStatePersistenceAdapter {
  loadAll(): Record<string, GptConstraintSessionRecord> | null;
  saveAll(records: Record<string, GptConstraintSessionRecord>): void;
}

export interface GptConstraintSessionStateOptions {
  globalAutoEnable?: boolean;
  persistence?: ConstraintStatePersistenceAdapter;
}

/**
 * Per-session deterministic state machine for GPT zero-tolerance engineering constraints.
 * States:
 * - UNASKED: Initial state; GPT not yet detected or user not yet asked.
 * - ENABLED: User confirmed (or global auto-enable configured); hard constraints injected.
 * - DECLINED: User explicitly declined; no repeated prompts and no injection in this session.
 */
export class GptConstraintSessionState {
  private readonly sessions = new Map<string, GptConstraintSessionRecord>();
  private globalAutoEnable: boolean;
  private readonly persistence?: ConstraintStatePersistenceAdapter;

  constructor(options: GptConstraintSessionStateOptions = {}) {
    this.globalAutoEnable = options.globalAutoEnable === true;
    this.persistence = options.persistence;
    if (this.persistence) {
      this.hydrateFromPersistence();
    }
  }

  setGlobalAutoEnable(enabled: boolean): void {
    this.globalAutoEnable = enabled;
  }

  isGlobalAutoEnable(): boolean {
    return this.globalAutoEnable;
  }

  getStatus(sessionId: string): ConstraintSessionStatus {
    this.assertValidSessionId(sessionId);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing.status;
    }
    if (this.globalAutoEnable) {
      return 'ENABLED';
    }
    return 'UNASKED';
  }

  getRecord(sessionId: string): GptConstraintSessionRecord {
    this.assertValidSessionId(sessionId);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return { ...existing };
    }
    return {
      sessionId,
      status: this.globalAutoEnable ? 'ENABLED' : 'UNASKED',
      detectionSource: this.globalAutoEnable ? 'global_config' : 'none',
      updatedAt: Date.now(),
    };
  }

  transition(
    sessionId: string,
    nextStatus: ConstraintSessionStatus,
    metadata?: { detectedModel?: string; detectionSource?: DetectionSource },
  ): GptConstraintSessionRecord {
    this.assertValidSessionId(sessionId);
    if (!VALID_STATUSES.has(nextStatus)) {
      throw new ConstraintStateCorruptedError(`Invalid target status "${String(nextStatus)}"`);
    }

    const currentStatus = this.getStatus(sessionId);
    const allowed = ALLOWED_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.has(nextStatus)) {
      throw new IllegalConstraintStateTransitionError(sessionId, currentStatus, nextStatus);
    }

    const previous = this.sessions.get(sessionId);
    const record: GptConstraintSessionRecord = {
      sessionId,
      status: nextStatus,
      detectedModel: metadata?.detectedModel ?? previous?.detectedModel,
      detectionSource: metadata?.detectionSource ?? previous?.detectionSource,
      updatedAt: Date.now(),
    };

    this.sessions.set(sessionId, record);
    this.persist();
    return { ...record };
  }

  enable(
    sessionId: string,
    metadata?: { detectedModel?: string; detectionSource?: DetectionSource },
  ): GptConstraintSessionRecord {
    return this.transition(sessionId, 'ENABLED', metadata);
  }

  decline(
    sessionId: string,
    metadata?: { detectedModel?: string; detectionSource?: DetectionSource },
  ): GptConstraintSessionRecord {
    return this.transition(sessionId, 'DECLINED', metadata);
  }

  /**
   * Explicitly hydrate a single session record (e.g. from persisted Conversation metadata).
   * Throws ConstraintStateCorruptedError if the record is malformed.
   */
  hydrateSession(sessionId: string, status: unknown, metadata?: { detectedModel?: string; detectionSource?: DetectionSource; updatedAt?: number }): void {
    this.assertValidSessionId(sessionId);
    if (typeof status !== 'string' || !VALID_STATUSES.has(status as ConstraintSessionStatus)) {
      throw new ConstraintStateCorruptedError(
        `Invalid persisted status for session "${sessionId}": ${JSON.stringify(status)}`,
      );
    }
    this.sessions.set(sessionId, {
      sessionId,
      status: status as ConstraintSessionStatus,
      detectedModel: metadata?.detectedModel,
      detectionSource: metadata?.detectionSource,
      updatedAt: typeof metadata?.updatedAt === 'number' && Number.isFinite(metadata.updatedAt)
        ? metadata.updatedAt
        : Date.now(),
    });
  }

  serialize(): string {
    const obj: Record<string, GptConstraintSessionRecord> = {};
    for (const [id, record] of this.sessions.entries()) {
      obj[id] = record;
    }
    return JSON.stringify(obj, null, 2);
  }

  deserialize(rawJson: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (error) {
      throw new ConstraintStateCorruptedError('Failed to parse session state JSON', error);
    }
    this.loadRecordMap(parsed);
  }

  clear(): void {
    this.sessions.clear();
    this.persist();
  }

  deleteSession(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      this.persist();
    }
    return deleted;
  }

  private hydrateFromPersistence(): void {
    if (!this.persistence) return;
    const loaded = this.persistence.loadAll();
    if (loaded === null) return;
    this.loadRecordMap(loaded);
  }

  private loadRecordMap(parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConstraintStateCorruptedError('Root state payload must be a plain object');
    }
    const next = new Map<string, GptConstraintSessionRecord>();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ConstraintStateCorruptedError(`Record for "${key}" is not an object`);
      }
      const rec = value as Partial<GptConstraintSessionRecord>;
      if (typeof rec.sessionId !== 'string' || !rec.sessionId.trim() || rec.sessionId !== key) {
        throw new ConstraintStateCorruptedError(`Mismatched or missing sessionId for key "${key}"`);
      }
      if (!rec.status || !VALID_STATUSES.has(rec.status)) {
        throw new ConstraintStateCorruptedError(`Invalid status "${String(rec.status)}" for session "${key}"`);
      }
      if (typeof rec.updatedAt !== 'number' || !Number.isFinite(rec.updatedAt)) {
        throw new ConstraintStateCorruptedError(`Invalid updatedAt for session "${key}"`);
      }
      next.set(key, {
        sessionId: rec.sessionId,
        status: rec.status,
        detectedModel: typeof rec.detectedModel === 'string' ? rec.detectedModel : undefined,
        detectionSource: typeof rec.detectionSource === 'string'
          ? (rec.detectionSource as DetectionSource)
          : undefined,
        updatedAt: rec.updatedAt,
      });
    }
    this.sessions.clear();
    for (const [id, rec] of next.entries()) {
      this.sessions.set(id, rec);
    }
  }

  private persist(): void {
    if (!this.persistence) return;
    const obj: Record<string, GptConstraintSessionRecord> = {};
    for (const [id, record] of this.sessions.entries()) {
      obj[id] = record;
    }
    this.persistence.saveAll(obj);
  }

  private assertValidSessionId(sessionId: string): void {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new ConstraintStateCorruptedError('sessionId must be a non-empty string');
    }
  }
}

export const gptConstraintSessionState = new GptConstraintSessionState();
