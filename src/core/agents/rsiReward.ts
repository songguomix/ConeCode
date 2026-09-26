// RSI+RL reward and selection — pure functions so the "RL" step is auditable
// code, not just prompt prose.
//
// Hard gate: a candidate whose external criteria failed has NO reward (never
// beats baseline). Soft shaping (judge scores) only ranks candidates that
// already passed the external oracle — judges cannot buy a red candidate a win
// (GAI anchored + Trusting Trust: score pressure must not override safety).

export interface MetricDelta {
  /** Stable metric id (e.g. "test.passRate", "typecheck.errors"). */
  id: string;
  /** Signed improvement after the change; positive = better. */
  delta: number;
  /** Relative weight in the composite metric term (default 1). */
  weight?: number;
}

export interface JudgeScores {
  /** 0–1. How well the change matches its hypothesis / charter goal. */
  alignment: number;
  /** 0–1. Simplicity & reusability (penalize single-fixture hacks). */
  simplicity: number;
  /** 0–1. Safety / blast-radius discipline (1 = fully inside declared radius). */
  discipline: number;
}

export interface EpisodeResult {
  /** All declared external success criteria passed. */
  externalPass: boolean;
  metrics: MetricDelta[];
  judges: JudgeScores;
  /** Rough cost: files touched + LOC (used as a small penalty). */
  filesTouched: number;
  linesChanged: number;
}

const DEFAULT_COST_BUDGET = { files: 6, lines: 400 };

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Composite scalar reward in roughly [-2, 2].
 * externalPass is a hard gate: false → REWARD_FAIL regardless of judges.
 */
export function computeReward(r: EpisodeResult): number {
  if (!r.externalPass) return REWARD_FAIL;

  let metricTerm = 0;
  let weightSum = 0;
  for (const m of r.metrics) {
    const w = m.weight ?? 1;
    // tanh-bounds a single metric so one huge delta cannot dominate forever.
    metricTerm += w * Math.tanh(m.delta);
    weightSum += w;
  }
  const metricMean = weightSum > 0 ? metricTerm / weightSum : 0;

  const judgeMean =
    (clamp01(r.judges.alignment) + clamp01(r.judges.simplicity) + clamp01(r.judges.discipline)) / 3;

  // Cost penalty: mild for staying near budget, heavier when blown past it.
  const fileOver = Math.max(0, r.filesTouched - DEFAULT_COST_BUDGET.files) / DEFAULT_COST_BUDGET.files;
  const lineOver = Math.max(0, r.linesChanged - DEFAULT_COST_BUDGET.lines) / DEFAULT_COST_BUDGET.lines;
  const costPenalty = 0.25 * fileOver + 0.25 * lineOver;

  // External metrics dominate; judges only shape among passing candidates.
  return 1.2 * metricMean + 0.8 * judgeMean - costPenalty;
}

/** Sentinel for a hard fail — never selected over a real score. */
export const REWARD_FAIL = -999;

export type SelectDecision =
  | { accept: true; reason: 'improves-best' | 'first-passing' }
  | { accept: false; reason: 'external-fail' | 'not-better-than-best' | 'not-better-than-baseline' };

/**
 * Greedy policy improvement: accept only if the candidate is strictly better
 * than the incumbent (baseline at episode 0). RL-style hill-climb without
 * letting a lucky judge panel override the external gate.
 */
export function selectCandidate(
  candidate: EpisodeResult,
  best: { reward: number } | null,
  baseline: { reward: number },
  /** Minimum improvement to count as progress (stops metric thrash). */
  epsilon = 1e-3,
): SelectDecision {
  if (!candidate.externalPass) return { accept: false, reason: 'external-fail' };
  const reward = computeReward(candidate);
  if (best == null) {
    if (reward > baseline.reward + epsilon) return { accept: true, reason: 'first-passing' };
    return { accept: false, reason: 'not-better-than-baseline' };
  }
  if (reward > best.reward + epsilon) return { accept: true, reason: 'improves-best' };
  return { accept: false, reason: 'not-better-than-best' };
}

/**
 * Convergence test: stop when the last `window` accepted rewards fail to beat
 * the previous best by more than epsilon (plateau ≈ local optimum).
 */
export function isConverged(rewardHistory: number[], window = 3, epsilon = 1e-3): boolean {
  if (rewardHistory.length < window) return false;
  const tail = rewardHistory.slice(-window);
  const priorBest = Math.max(...rewardHistory.slice(0, -window), -Infinity);
  const tailBest = Math.max(...tail);
  return tailBest <= priorBest + epsilon;
}
