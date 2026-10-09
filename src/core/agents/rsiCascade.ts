import { REWARD_FAIL } from './rsiReward';

// AlphaEvolve-style evaluation cascade for RSI+RL verification.
//
// Running the full suite + every frozen metric + the judge panel on every
// candidate burns the budget on obvious losers. A cascade runs stages of
// increasing cost and stops at the first failure — cheap gates (typecheck,
// targeted tests) prune before anything expensive (full suite, judges) runs.
// The agent declares the stages up front (frozen with the goal vector); this
// module is the gate logic + cost accounting.

export interface CascadeStage {
  id: string;
  /** Human label, e.g. "typecheck". */
  label: string;
  /** Exact command the agent runs (frozen, never edited to pass). */
  command: string;
  /** Relative cost unit (typecheck = 1). */
  cost: number;
}

/** The default ConeCode cascade, cheapest first. */
export const DEFAULT_CASCADE: CascadeStage[] = [
  { id: 'compile', label: 'typecheck', command: 'npm run typecheck', cost: 1 },
  { id: 'targeted', label: 'targeted tests', command: 'npx vitest run <touched-area>', cost: 2 },
  { id: 'full', label: 'full suite + frozen metrics', command: 'npm test + GOAL_VECTOR.md metric commands', cost: 5 },
  { id: 'judges', label: 'judge panel', command: 'spawn alignment/simplicity/discipline judges', cost: 8 },
];

export interface StageOutcome {
  stageId: string;
  passed: boolean;
}

export interface CascadeState {
  /** Stages completed in order. */
  done: StageOutcome[];
  /** First failed stage id, once the cascade stops. */
  stoppedAt: string | null;
}

/** Fold one stage result into the cascade state. */
export function recordStage(state: CascadeState, outcome: StageOutcome): CascadeState {
  if (state.stoppedAt) return state; // stopped cascades stay stopped
  const done = [...state.done, outcome];
  return { done, stoppedAt: outcome.passed ? null : outcome.stageId };
}

/** Next stage to run, or null when the cascade stopped or finished. */
export function nextStage(stages: CascadeStage[], state: CascadeState): CascadeStage | null {
  if (state.stoppedAt) return null;
  const doneIds = new Set(state.done.map((d) => d.stageId));
  return stages.find((s) => !doneIds.has(s.id)) ?? null;
}

/** True once every stage passed — only then may judges score / reward count. */
export function cascadePassed(stages: CascadeStage[], state: CascadeState): boolean {
  return state.stoppedAt === null &&
    stages.every((s) => state.done.some((d) => d.stageId === s.id && d.passed));
}

/** Cost spent so far, in stage cost units. */
export function cascadeSpent(stages: CascadeStage[], state: CascadeState): number {
  const costOf = new Map(stages.map((s) => [s.id, s.cost]));
  return state.done.reduce((sum, d) => sum + (costOf.get(d.stageId) ?? 0), 0);
}

/** Full-cascade price (for "this FAIL cost X of Y" reporting). */
export function cascadeTotal(stages: CascadeStage[]): number {
  return stages.reduce((sum, s) => sum + s.cost, 0);
}

export interface EpisodeSample {
  id: string;
  /** Composite reward (REWARD_FAIL for hard failures). */
  reward: number;
  externalPass: boolean;
}

/**
 * SEAL-style trial-and-error within one episode: sample up to K candidates,
 * keep the best passing one. Pure pick — the agent runs the samples, this
 * only decides which (if any) proceeds to registration.
 */
export function pickBestSample(samples: EpisodeSample[]): EpisodeSample | null {
  let best: EpisodeSample | null = null;
  for (const s of samples) {
    if (!s.externalPass || s.reward <= REWARD_FAIL / 2) continue;
    if (!best || s.reward > best.reward) best = s;
  }
  return best;
}
