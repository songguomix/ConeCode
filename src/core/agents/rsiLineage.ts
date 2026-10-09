import { REWARD_FAIL } from './rsiReward';

// DGM-style lineage for RSI+RL (Zhang et al., arXiv:2505.22954).
//
// The current loop hill-climbs from a single incumbent. DGM's ablations show
// that pure hill-climbing stalls (23% vs 50% on SWE-bench): breakthroughs
// often descend from low-scoring ancestors, so the search must keep an
// archive of ALL variants and branch from it — favoring strong but
// underexplored lineages, never discarding a lineage's right to be sampled.
//
// Pure functions over a serializable archive (the on-disk form stays
// `.conecode/rsi/iterations/*.md` + `trees/*.json`; this module is the scoring
// core the agent applies when choosing what to branch from next).

export interface ArchiveNode {
  id: string;
  /** Parent archive id, or null for a branch off the episode root. */
  parentId: string | null;
  /** Harness module this variant touched (ModularRSI surface). */
  module: string;
  /** Accepted into the incumbent line. */
  accepted: boolean;
  /** Composite reward (REWARD_FAIL for hard external failures). */
  reward: number;
  /** Declared external criteria all passed. */
  externalPass: boolean;
  /** Archived children already branched from this node. */
  children: number;
  /** Per-metric signed deltas (for Pareto / merge reasoning). */
  metrics: Record<string, number>;
  note?: string;
}

/** A node can parent new work iff it is empirically viable. Hard external
 *  failures are never branched from (DGM discards non-compiling agents) —
 *  but a *rejected* node that passed the external gate stays eligible: it
 *  may be the stepping stone the next breakthrough needs. */
export function isBranchable(n: ArchiveNode): boolean {
  return n.externalPass && n.reward > REWARD_FAIL / 2;
}

/**
 * DGM parent weight: roughly proportional to performance, inversely
 * proportional to existing children (exploit strong performers, explore
 * underexplored lineages). `floor` keeps every branchable node samplable —
 * no lineage is ever fully abandoned.
 */
export function parentWeight(n: ArchiveNode, floor = 0.05): number {
  if (!isBranchable(n)) return 0;
  // Shift rewards so the worst branchable node still carries the floor.
  const signal = Math.max(0, n.reward);
  return floor + signal / (1 + Math.max(0, n.children));
}

/** Branchable nodes ordered best-parent-first (stable for ties). */
export function rankParents(nodes: ArchiveNode[]): ArchiveNode[] {
  return nodes
    .map((n, i) => ({ n, i, w: parentWeight(n) }))
    .filter((x) => x.w > 0)
    .sort((a, b) => (b.w - a.w) || (a.i - b.i))
    .map((x) => x.n);
}

/**
 * Stochastic parent pick honoring the weights (seeded `rand` keeps it
 * testable). Greedy hill-climbing is `exploration = 0` (always #1);
 * DGM-style open-ended search wants exploration > 0 so lower-ranked
 * lineages still get sampled.
 */
export function pickParent(ranked: ArchiveNode[], rand: () => number = Math.random): ArchiveNode | null {
  if (!ranked.length) return null;
  const weights = ranked.map((n) => parentWeight(n));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return ranked[0];
  let r = rand() * total;
  for (let i = 0; i < ranked.length; i++) {
    r -= weights[i];
    if (r <= 0) return ranked[i];
  }
  return ranked[ranked.length - 1];
}

/** Root ancestor id (follows parentId; a rootless node is its own root). */
export function rootOf(nodes: ArchiveNode[], id: string): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let cur = id;
  const seen = new Set<string>();
  while (byId.get(cur)?.parentId && !seen.has(cur)) {
    seen.add(cur);
    cur = byId.get(cur)!.parentId!;
  }
  return cur;
}

/**
 * Stepping stones (DGM): rejected nodes worth branching from anyway — they
 * passed the external gate but lost on composite reward. Ranked by reward,
 * so the most promising near-miss goes first.
 */
export function steppingStones(nodes: ArchiveNode[]): ArchiveNode[] {
  return nodes
    .filter((n) => isBranchable(n) && !n.accepted)
    .sort((a, b) => b.reward - a.reward);
}

function metricIds(nodes: ArchiveNode[]): string[] {
  const ids = new Set<string>();
  for (const n of nodes) for (const k of Object.keys(n.metrics)) ids.add(k);
  return [...ids];
}

/**
 * GEPA-style system-aware merge pair: two ACCEPTED nodes from different
 * lineages (different roots) that are each strictly best on at least one
 * metric — complementary strengths worth combining into one candidate.
 * Null when no such pair exists (e.g. a single lineage so far).
 */
export function mergePair(nodes: ArchiveNode[]): { a: ArchiveNode; b: ArchiveNode } | null {
  const accepted = nodes.filter((n) => n.accepted && isBranchable(n));
  if (accepted.length < 2) return null;
  const ids = metricIds(accepted);
  const bestOn = (metric: string): ArchiveNode[] => {
    let best = -Infinity;
    for (const n of accepted) best = Math.max(best, n.metrics[metric] ?? -Infinity);
    return accepted.filter((n) => (n.metrics[metric] ?? -Infinity) === best && best > -Infinity);
  };
  let bestPair: { a: ArchiveNode; b: ArchiveNode; gain: number } | null = null;
  for (let i = 0; i < accepted.length; i++) {
    for (let j = i + 1; j < accepted.length; j++) {
      const a = accepted[i];
      const b = accepted[j];
      if (rootOf(nodes, a.id) === rootOf(nodes, b.id)) continue; // same lineage — not a merge
      // Complementary iff each leads on something the other doesn't.
      const aLeads = ids.filter((m) => (a.metrics[m] ?? -Infinity) > (b.metrics[m] ?? -Infinity));
      const bLeads = ids.filter((m) => (b.metrics[m] ?? -Infinity) > (a.metrics[m] ?? -Infinity));
      if (!aLeads.length || !bLeads.length) continue;
      const gain = Math.max(...aLeads.map((m) => a.metrics[m])) + Math.max(...bLeads.map((m) => b.metrics[m]));
      if (!bestPair || gain > bestPair.gain) bestPair = { a, b, gain };
    }
  }
  return bestPair ? { a: bestPair.a, b: bestPair.b } : null;
}
