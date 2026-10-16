// DREAM offline replay — compare EXPLORATION policies on recorded facts.
//
// Strict separation: replay scores how cheaply an exploration policy would
// have re-discovered the recorded rewards. It NEVER re-runs tests, NEVER
// fabricates a new product reward, and NEVER counts as product verification.
// Product acceptance still requires VERIFY (see rsiLoop + rsiReward).
//
//   V(tree | policy) = maxReward - beta1 * N + beta2 * N / max(1, rounds)
//
// N = revealed attempts (capped by policy.maxAttempts, in recorded order),
// rounds = ceil(N / parallelism). A policy that needs fewer attempts to reach
// the same recorded best scores higher; a policy that truncates before the
// best scores lower. Monotone select keeps the incumbent on ties or thin data.

import { REWARD_FAIL } from './rsiReward';
import type { DiscoveryTree } from './rsiTree';

export interface ExplorationPolicy {
  id: string;
  /** Max attempts revealed per tree (serial sampling budget). */
  maxAttempts: number;
  /** Distinct modules the policy aims to spread across (>=1). */
  moduleSpread: number;
  /** Parallel workers for the batching bonus (rounds = ceil(N / W)). */
  parallelism?: number;
  /** Declared edit budget carried by the policy (advisory, not enforced here). */
  maxFiles?: number;
  maxLines?: number;
  rationale?: string;
}

export const DEFAULT_EXPLORATION_POLICY: ExplorationPolicy = {
  id: 'default',
  maxAttempts: 3,
  moduleSpread: 2,
  parallelism: 1,
  maxFiles: 6,
  maxLines: 400,
  rationale: 'default: small serial budget until history says otherwise',
};

export interface ReplayOpts {
  beta1?: number;
  beta2?: number;
}

export interface ReplayScore {
  episodeId: string;
  policyId: string;
  /** Best RECORDED reward among revealed nodes (REWARD_FAIL when none pass). */
  maxReward: number;
  /** Revealed attempts (<= policy.maxAttempts). */
  attempts: number;
  rounds: number;
  /** V quality-minus-cost-plus-batching. */
  score: number;
}

function validPolicy(p: ExplorationPolicy): string | null {
  if (!p.id || !p.id.trim()) return 'policy id must be non-empty';
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) return 'maxAttempts must be a positive integer';
  if (!Number.isInteger(p.moduleSpread) || p.moduleSpread < 1) return 'moduleSpread must be a positive integer';
  const w = p.parallelism ?? 1;
  if (!Number.isInteger(w) || w < 1) return 'parallelism must be a positive integer';
  return null;
}

/**
 * Score one policy on one recorded tree by replay only. Reveals the first
 * `maxAttempts` recorded nodes in insertion order — the order the online run
 * actually paid for — and reads their stored rewards. No execution.
 */
export function replayScore(tree: DiscoveryTree, policy: ExplorationPolicy, opts: ReplayOpts = {}): ReplayScore {
  const invalid = validPolicy(policy);
  if (invalid) throw new Error(`invalid exploration policy: ${invalid}`);
  const beta1 = opts.beta1 ?? 0.05;
  const beta2 = opts.beta2 ?? 0.02;
  const revealed = tree.nodes.slice(0, Math.max(0, policy.maxAttempts));
  const n = revealed.length;
  const parallelism = policy.parallelism ?? 1;
  const rounds = Math.max(1, Math.ceil(n / Math.max(1, parallelism)));
  let maxReward = REWARD_FAIL;
  for (const node of revealed) {
    if (node.reward > maxReward) maxReward = node.reward;
  }
  // Empty history reveals nothing: score is pure cost of zero attempts.
  const score = (n === 0 ? REWARD_FAIL : maxReward) - beta1 * n + beta2 * (n / rounds);
  return { episodeId: tree.episodeId, policyId: policy.id, maxReward: n === 0 ? REWARD_FAIL : maxReward, attempts: n, rounds, score };
}

export interface PolicyMeanScore {
  policyId: string;
  mean: number;
  samples: number;
}

export function evaluatePolicies(
  policies: ExplorationPolicy[],
  trees: DiscoveryTree[],
  opts: ReplayOpts = {},
): { perPolicy: PolicyMeanScore[]; perTree: ReplayScore[] } {
  const perTree: ReplayScore[] = [];
  const perPolicy: PolicyMeanScore[] = policies.map((p) => {
    if (trees.length === 0) return { policyId: p.id, mean: REWARD_FAIL, samples: 0 };
    let sum = 0;
    for (const t of trees) {
      const s = replayScore(t, p, opts);
      perTree.push(s);
      sum += s.score;
    }
    return { policyId: p.id, mean: sum / trees.length, samples: trees.length };
  });
  return { perPolicy, perTree };
}

export interface SelectOpts extends ReplayOpts {
  /** Minimum trees required before any non-default policy may deploy. */
  minTrees?: number;
  /** Minimum recorded experiments required in total. */
  minExperiments?: number;
  /** Improvement margin the challenger must clear over the incumbent. */
  epsilon?: number;
}

export interface SelectOutcome {
  policy: ExplorationPolicy;
  meanScores: PolicyMeanScore[];
  evidenceSufficient: boolean;
  /** Why this policy (kept default on thin data / ties / no clear winner). */
  reason: string;
}

/**
 * Monotone select: the argmax mean-V among {incumbent ∪ candidates} deploys.
 * The incumbent wins ties, so the exploration policy never regresses on the
 * fixed history. With too little history the default/incumbent is retained
 * and evidenceSufficient=false — no "learning" is claimed from thin data.
 */
export function selectExplorationPolicy(
  candidates: ExplorationPolicy[],
  incumbent: ExplorationPolicy,
  trees: DiscoveryTree[],
  opts: SelectOpts = {},
): SelectOutcome {
  const minTrees = opts.minTrees ?? 2;
  const minExperiments = opts.minExperiments ?? 4;
  const epsilon = opts.epsilon ?? 1e-6;
  const all = [incumbent, ...candidates.filter((c) => c.id !== incumbent.id)];
  // Validate all policies eagerly: a malformed challenger must not deploy.
  for (const p of all) {
    const invalid = validPolicy(p);
    if (invalid) throw new Error(`invalid exploration policy ${p.id}: ${invalid}`);
  }
  const totalExperiments = trees.reduce((a, t) => a + t.nodes.length, 0);
  const evidenceSufficient = trees.length >= minTrees && totalExperiments >= minExperiments;
  const { perPolicy } = evaluatePolicies(all, trees, opts);
  const scoreOf = (id: string) => perPolicy.find((s) => s.policyId === id)?.mean ?? REWARD_FAIL;
  if (!evidenceSufficient) {
    return {
      policy: incumbent,
      meanScores: perPolicy,
      evidenceSufficient: false,
      reason: `insufficient-history: need >=${minTrees} trees and >=${minExperiments} experiments, have ${trees.length} trees / ${totalExperiments} experiments`,
    };
  }
  let best = incumbent;
  let bestMean = scoreOf(incumbent.id);
  for (const c of candidates) {
    if (c.id === incumbent.id) continue;
    const m = scoreOf(c.id);
    if (m > bestMean + epsilon) {
      best = c;
      bestMean = m;
    }
  }
  const kept = best.id === incumbent.id;
  return {
    policy: best,
    meanScores: perPolicy,
    evidenceSufficient: true,
    reason: kept
      ? `monotone-keep: incumbent ${incumbent.id} unbeaten on ${trees.length} trees (mean ${bestMean.toFixed(4)})`
      : `improved: ${best.id} beats incumbent on replay (mean ${bestMean.toFixed(4)} vs ${scoreOf(incumbent.id).toFixed(4)})`,
  };
}

/**
 * Hard boundary marker for tests and reviewers: a replay outcome is an
 * exploration-policy score, never product evidence. It carries no
 * externalPass, no acceptance, no verification.
 */
export function isReplayProductVerification(_score: ReplayScore): false {
  return false;
}
