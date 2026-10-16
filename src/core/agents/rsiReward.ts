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
  /**
   * Signed improvement in natural units; positive = better. NOT comparable
   * across metrics until divided by `scale` — seconds, MB, and error counts
   * must never share one tanh.
   */
  delta: number;
  /** Relative weight in the composite metric term (default 1). */
  weight?: number;
  /**
   * Normalizer: what counts as "one unit" of improvement on this metric
   * (e.g. 10 for seconds, 0.01 for a ratio). Default 1 (backward compatible).
   */
  scale?: number;
  /**
   * Hard floor in SCALED units: fall below and the candidate fails outright,
   * no matter what else improved. This is how a no-regression metric
   * (error count, failing tests) refuses to be bought off by a faster clock.
   */
  minDelta?: number;
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
 * So is any hard-floor breach: a no-regression metric cannot be averaged away.
 */
export function computeReward(r: EpisodeResult): number {
  if (!r.externalPass) return REWARD_FAIL;
  if (breachesHardFloor(r).length > 0) return REWARD_FAIL;

  let metricTerm = 0;
  let weightSum = 0;
  for (const m of r.metrics) {
    const w = m.weight ?? 1;
    // tanh-bounds a single NORMALIZED metric so one huge delta cannot
    // dominate forever. Normalization is per-metric: scale lives on the
    // MetricDelta because only the metric owner knows its units.
    metricTerm += w * Math.tanh(scaledDelta(m));
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

/** delta in comparable units: raw improvement divided by the metric's scale. */
export function scaledDelta(m: MetricDelta): number {
  const scale = m.scale ?? 1;
  return m.delta / Math.max(scale, 1e-9);
}

/** Ids of metrics sitting below their hard floor (no-regression violated). */
export function breachesHardFloor(r: EpisodeResult): string[] {
  return r.metrics
    .filter((m) => m.minDelta != null && scaledDelta(m) < m.minDelta)
    .map((m) => m.id);
}

export type SelectDecision =
  | { accept: true; reason: 'improves-best' | 'first-passing' }
  | { accept: false; reason: 'external-fail' | 'discipline-veto' | 'hard-floor-breach' | 'not-better-than-best' | 'not-better-than-baseline' };

/**
 * Greedy policy improvement: accept only if the candidate is strictly better
 * than the incumbent (baseline at episode 0). RL-style hill-climb without
 * letting a lucky judge panel override the external gate.
 *
 * Two vetoes short-circuit before any reward comparison, and NEITHER can be
 * averaged away:
 * - external-fail: the oracle did not pass.
 * - discipline-veto: ANY safety/blast-radius risk (discipline 0, NaN, or
 *   missing). A 1.0 alignment plus a 1.0 simplicity still lose to a veto.
 * - hard-floor-breach: a no-regression metric regressed.
 */
export function selectCandidate(
  candidate: EpisodeResult,
  best: { reward: number } | null,
  baseline: { reward: number },
  /** Minimum improvement to count as progress (stops metric thrash). */
  epsilon = 1e-3,
): SelectDecision {
  if (!candidate.externalPass) return { accept: false, reason: 'external-fail' };
  if (clamp01(candidate.judges.discipline) <= 0) return { accept: false, reason: 'discipline-veto' };
  if (breachesHardFloor(candidate).length > 0) return { accept: false, reason: 'hard-floor-breach' };
  const reward = computeReward(candidate);
  if (best == null) {
    if (reward > baseline.reward + epsilon) return { accept: true, reason: 'first-passing' };
    return { accept: false, reason: 'not-better-than-baseline' };
  }
  if (reward > best.reward + epsilon) return { accept: true, reason: 'improves-best' };
  return { accept: false, reason: 'not-better-than-best' };
}

/**
 * One decision covering all four fates, so the Pareto front actually steers
 * the loop instead of sitting beside it:
 * 1. hard violation (external fail, discipline veto, hard floor) → reject.
 * 2. strictly better than best → replace the incumbent.
 * 3. not better overall, but non-dominated vs the archive → keep as frontier.
 * 4. dominated everywhere → reject.
 */
export type ArchiveVerdict =
  | { action: 'replace-best'; reason: 'improves-best' | 'first-passing' }
  | { action: 'retain-frontier'; reason: 'pareto-nondominated' }
  | { action: 'reject'; reason: 'external-fail' | 'discipline-veto' | 'hard-floor-breach' | 'not-better-than-best' | 'not-better-than-baseline' };

export function selectForArchive(
  candidate: EpisodeResult,
  candidateId: string,
  best: { reward: number } | null,
  baseline: { reward: number },
  archive: ParetoCandidate[],
  epsilon = 1e-3,
): ArchiveVerdict {
  // Idempotency: a repeated delivery of an already-archived id must not
  // double-register or flip the verdict. Recompute the same decision
  // deterministically instead of appending a duplicate frontier node.
  const already = archive.some((o) => o.id === candidateId);
  const d = selectCandidate(candidate, best, baseline, epsilon);
  if (d.accept) return { action: 'replace-best', reason: d.reason };
  if (d.reason !== 'not-better-than-best' && d.reason !== 'not-better-than-baseline') {
    return { action: 'reject', reason: d.reason };
  }
  if (already) return { action: 'reject', reason: d.reason };
  const metrics: Record<string, number> = {};
  for (const m of candidate.metrics) metrics[m.id] = scaledDelta(m);
  const node: ParetoCandidate = { id: candidateId, metrics };
  const dominated = archive.some((o) => o.id !== candidateId && dominates(o, node));
  if (!dominated) return { action: 'retain-frontier', reason: 'pareto-nondominated' };
  return { action: 'reject', reason: d.reason };
}

/**
 * Add a frontier node and drop members it (or others) dominate, so the
 * archive stays the true non-dominated set. Idempotent on id.
 */
export function pruneParetoArchive(archive: ParetoCandidate[], node: ParetoCandidate): ParetoCandidate[] {
  const next = archive.some((c) => c.id === node.id)
    ? archive.map((c) => (c.id === node.id ? node : c))
    : [...archive, node];
  return next.filter((c) => !next.some((o) => o !== c && dominates(o, c)));
}

/**
 * Convergence test: stop when the last `window` accepted rewards fail to beat
 * the previous best by more than epsilon (plateau ≈ budget-limited local
 * convergence — NEVER a proof of global optimality; see rsiLoop.evaluateStop
 * for the evidence-aware stop that also weighs module breadth, repeated
 * failures, and remaining budget).
 *
 * REWARD_FAIL sentinels (hard-gate breaches) are ignored here: consecutive
 * hard fails are a separate stop condition (broken oracle), not a plateau.
 */
export function isConverged(rewardHistory: number[], window = 3, epsilon = 1e-3): boolean {
  const hist = rewardHistory.filter((r) => r !== REWARD_FAIL);
  if (hist.length < window + 1) return false;
  const tail = hist.slice(-window);
  const priorBest = Math.max(...hist.slice(0, -window));
  const tailBest = Math.max(...tail);
  return tailBest <= priorBest + epsilon;
}

/**
 * Budget-limited local-plateau alias. Same test as isConverged; renamed so
 * call sites and reports cannot mistake "3 tries without improvement" for a
 * global optimum. Always report "no better candidate within budget".
 */
export function isLocalPlateau(rewardHistory: number[], window = 3, epsilon = 1e-3): boolean {
  return isConverged(rewardHistory, window, epsilon);
}

// ---------------------------------------------------------------------------
// GEPA-style Pareto retention + calibrated judging (additive; the greedy
// single-objective path above is unchanged).
//
// A single composite reward averages complementary strengths away: a
// candidate that is uniquely best on one frozen metric should survive even
// when its composite trails. The Pareto front keeps exactly those.
// ---------------------------------------------------------------------------

export interface ParetoCandidate {
  id: string;
  /** Per-metric signed deltas (higher = better on every axis). */
  metrics: Record<string, number>;
}

/** True when `a` is at least as good on every metric and better on one. */
export function dominates(a: ParetoCandidate, b: ParetoCandidate): boolean {
  const keys = new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)]);
  if (keys.size === 0) return false;
  let better = false;
  for (const k of keys) {
    const av = a.metrics[k] ?? -Infinity;
    const bv = b.metrics[k] ?? -Infinity;
    if (av < bv) return false;
    if (av > bv) better = true;
  }
  return better;
}

/** Non-dominated candidates — each is the best at something. Stable order. */
export function paretoFront(cands: ParetoCandidate[]): ParetoCandidate[] {
  return cands.filter((c) => !cands.some((o) => o !== c && dominates(o, c)));
}

/** Ids that lead outright on each metric (GEPA best-per-instance anchors). */
export function bestOnEachMetric(cands: ParetoCandidate[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const keys = new Set<string>();
  for (const c of cands) for (const k of Object.keys(c.metrics)) keys.add(k);
  for (const k of keys) {
    let best = -Infinity;
    for (const c of cands) best = Math.max(best, c.metrics[k] ?? -Infinity);
    out[k] = cands.filter((c) => (c.metrics[k] ?? -Infinity) === best).map((c) => c.id);
  }
  return out;
}

/**
 * Calibrated judging across 2+ panels (Self-Rewarding insight: judges drift).
 * Discipline veto is preserved and widened: ANY panel's veto discards the
 * candidate. Otherwise each axis takes the trimmed mean (drop min/max with
 * ≥3 panels), so one loud judge cannot buy a win.
 */
export function combineJudgePanels(panels: JudgeScores[]): JudgeScores {
  if (!panels.length) return { alignment: 0, simplicity: 0, discipline: 0 };
  if (panels.some((p) => clamp01(p.discipline) <= 0)) {
    const rest = combineWithoutDiscipline(panels);
    return { ...rest, discipline: 0 };
  }
  return combineWithoutDiscipline(panels, true);
}

function trimmedMean(values: number[]): number {
  const xs = [...values].sort((a, b) => a - b);
  const core = xs.length >= 3 ? xs.slice(1, -1) : xs;
  return core.reduce((a, b) => a + b, 0) / Math.max(1, core.length);
}

function combineWithoutDiscipline(panels: JudgeScores[], includeDiscipline = false): JudgeScores {
  const axis = (f: (p: JudgeScores) => number) => trimmedMean(panels.map((p) => clamp01(f(p))));
  return {
    alignment: axis((p) => p.alignment),
    simplicity: axis((p) => p.simplicity),
    discipline: includeDiscipline ? axis((p) => p.discipline) : 1,
  };
}
