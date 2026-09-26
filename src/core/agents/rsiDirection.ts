// Self-discovered breakthrough directions (the agent chooses *where* to push,
// not a fixed checklist). Pure scoring so "find your own direction" is not
// free-form wandering: every direction must carry evidence, expected metric
// move, feasibility, and risk — then rankScore orders them.

export interface DirectionEvidence {
  /** file:line, command output, or EVOLUTION_LOG id */
  ref: string;
  /** one line: what this shows */
  note: string;
}

export interface BreakthroughDirection {
  id: string;
  /** Short title, e.g. "unify error paths in agent loop". */
  title: string;
  /**
   * MUST name the useful capability the user gains — not "clean up code",
   * not metric theater. Example: "chat renders GFM tables" / "goal pause
   * actually stops the run".
   */
  usefulCapability: string;
  /** Which frozen goal-vector metric this should move. */
  metricId: string;
  /** Signed expected delta on that metric (direction of improvement). */
  expectedDelta: number;
  /** 0–1: how strongly evidence supports this (not vibes). */
  evidenceStrength: number;
  evidence: DirectionEvidence[];
  /** 0–1: can this land inside one small blast radius / edit budget? */
  feasibility: number;
  /** 0–1: chance of harming safety, tests, or product scope (0 = none). */
  risk: number;
  /**
   * 0–1: how much real user value this delivers. Required. Vanity polish,
   * dead code renames, and metric-only tweaks must score low and are rejected.
   */
  userValue: number;
  /** Module surface (ModularRSI). */
  module: 'loop' | 'tools' | 'observation' | 'context' | 'completion' | 'product';
}

/**
 * Priority score in roughly [0, 2+].
 * Usefulness is a first-class multiplier: a direction that does not deliver a
 * useful capability cannot outrank one that does, no matter how neat it looks.
 */
export function directionScore(d: BreakthroughDirection): number {
  const impact = Math.tanh(Math.max(0, d.expectedDelta)); // diminishing huge claims
  const evidence = clamp01(d.evidenceStrength);
  const feas = clamp01(d.feasibility);
  const risk = clamp01(d.risk);
  const useful = clamp01(d.userValue);
  // userValue gates the whole score: 0 utility ⇒ near-zero score.
  return useful * impact * (0.5 + 0.5 * evidence) * (0.3 + 0.7 * feas) * (1 - 0.85 * risk);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Ranked list, best first. Stable for equal scores (original order). */
export function rankDirections(list: BreakthroughDirection[]): BreakthroughDirection[] {
  return list
    .map((d, i) => ({ d, i, s: directionScore(d) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map((x) => x.d);
}

/**
 * The agent may only "self-pick" a breakthrough if it clears a minimal bar —
 * empty evidence, near-zero expected impact, or a non-useful capability is
 * not a direction, it's noise.
 */
export function isAcceptableDirection(d: BreakthroughDirection): boolean {
  if (!d.evidence.length) return false;
  if (!d.metricId.trim()) return false;
  if (!d.usefulCapability || d.usefulCapability.trim().length < 8) return false;
  if (d.userValue < 0.5) return false;
  if (d.expectedDelta <= 0) return false;
  if (d.evidenceStrength < 0.25) return false;
  if (d.risk >= 0.8) return false;
  return directionScore(d) > 0.05;
}

/** Pick the best acceptable direction, or null if none clear the bar. */
export function pickBreakthrough(
  list: BreakthroughDirection[],
): BreakthroughDirection | null {
  const ok = list.filter(isAcceptableDirection);
  if (!ok.length) return null;
  return rankDirections(ok)[0];
}
