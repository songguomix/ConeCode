import { CuaError } from '../protocol/errors.js';

export class CancellationToken {
  private _cancelled = false;
  private _reason: string | undefined;
  private listeners = new Set<(reason: string) => void>();

  get cancelled(): boolean {
    return this._cancelled;
  }

  get reason(): string | undefined {
    return this._reason;
  }

  cancel(reason: string): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this._reason = reason;
    for (const fn of this.listeners) {
      try {
        fn(reason);
      } catch {
        // Cancellation listeners must never prevent the others from running.
      }
    }
  }

  throwIfCancelled(): void {
    if (this._cancelled) throw new CuaError('CANCELLED', this._reason ?? 'Task cancelled.');
  }

  onCancel(fn: (reason: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export class BudgetTracker {
  readonly limits: {
    maxSteps: number;
    maxModelCalls: number;
    maxCodeRuns: number;
    maxRetriesPerAction: number;
    maxWallClockMs: number;
    maxCostUsd: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  private counts = {
    steps: 0,
    modelCalls: 0,
    codeRuns: 0,
    retries: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(
    limits: BudgetTracker['limits'],
    options: {
      startedAt?: number;
      counts?: Partial<BudgetTracker['counts']>;
      now?: () => number;
    } = {},
  ) {
    this.limits = limits;
    this.startedAt = options.startedAt ?? Date.now();
    this.now = options.now ?? Date.now;
    Object.assign(this.counts, options.counts ?? {});
  }

  snapshot(): typeof this.counts & { elapsedMs: number } {
    return { ...this.counts, elapsedMs: this.now() - this.startedAt };
  }

  addStep(n = 1): void {
    this.assert('maxSteps', this.counts.steps + n, 'steps');
    this.counts.steps += n;
  }

  addModelCall(inputTokens = 0, outputTokens = 0, costUsd = 0): void {
    this.assert('maxModelCalls', this.counts.modelCalls + 1, 'model calls');
    this.counts.modelCalls += 1;
    this.addModelUsage(inputTokens, outputTokens, costUsd);
  }

  addModelUsage(inputTokens = 0, outputTokens = 0, costUsd = 0): void {
    this.counts.inputTokens += inputTokens;
    this.counts.outputTokens += outputTokens;
    this.counts.costUsd += costUsd;
    this.assert('maxInputTokens', this.counts.inputTokens, 'input tokens');
    this.assert('maxOutputTokens', this.counts.outputTokens, 'output tokens');
    if (this.counts.costUsd > this.limits.maxCostUsd) {
      throw new CuaError('BUDGET_EXCEEDED', `Cost budget exceeded: $${this.counts.costUsd.toFixed(4)} > $${this.limits.maxCostUsd}.`, {
        details: this.snapshot(),
      });
    }
  }

  addCodeRun(): void {
    this.counts.codeRuns += 1;
    this.assert('maxCodeRuns', this.counts.codeRuns, 'code runs');
  }

  addRetry(): void {
    this.counts.retries += 1;
  }

  canRetry(retriesSoFar: number): boolean {
    return retriesSoFar < this.limits.maxRetriesPerAction;
  }

  assertTime(): void {
    const elapsed = this.now() - this.startedAt;
    if (elapsed > this.limits.maxWallClockMs) {
      throw new CuaError('BUDGET_EXCEEDED', `Wall-clock budget exceeded after ${elapsed}ms.`, {
        details: { elapsed, limit: this.limits.maxWallClockMs },
      });
    }
  }

  private assert(key: keyof typeof this.limits, value: number, label: string): void {
    if (value > this.limits[key]) {
      throw new CuaError('BUDGET_EXCEEDED', `Budget exceeded: ${label} ${value} > ${this.limits[key]}.`, {
        details: { budget: key, value, limit: this.limits[key] },
      });
    }
  }
}

/** Serialize writes per session. Keys can also represent shared business objects. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isLocked(key: string): boolean {
    return this.tails.has(key);
  }

  size(): number {
    return this.tails.size;
  }
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new CuaError('CANCELLED', 'Sleep aborted.'));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new CuaError('CANCELLED', 'Sleep aborted.'));
        },
        { once: true },
      );
    }),
};
