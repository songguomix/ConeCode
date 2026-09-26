// Discovery-tree replay scoring for RSI+RL "dreaming" (Dream-RSI,
// arXiv:2609.14858). Pure functions — no store, no LLM calls.
//
// Idea: a finished online episode is a tree of attempts. Alternative
// *exploration policies* can be scored by walking recorded children only
// (zero re-execution). The replay objective balances quality, cost, and
// useful parallelism — then we greedily keep the better exploration policy.

export interface AttemptNode {
  id: string;
  /** Parent attempt id, or null for a branch off the root. */
  parentId: string | null;
  /** Reward from rsiReward.computeReward (already hard-gated externally). */
  reward: number;
  /** How many generation/eval steps this attempt represented (usually 1). */
  costSteps: number;
  /** True if the candidate was accepted into the incumbent policy. */
  accepted: boolean;
}

export interface DiscoveryTree {
  id: string;
  /** All attempts in this online rollout. */
  nodes: AttemptNode[];
}

/** How far an exploration policy walks the tree when replaying. */
export interface ReplayTrace {
  /** Revealed non-root node ids in decision order. */
  revealed: string[];
  /** Number of non-empty decision rounds (batch decisions). */
  rounds: number;
}

/**
 * Dream-RSI Eq. (1), adapted:
 *   V = max(reward) − β₁·N + β₂·N/max(1, rounds)
 * N counts revealed attempts; rounds = decision batches (parallelism proxy).
 */
export function replayScore(
  tree: DiscoveryTree,
  trace: ReplayTrace,
  beta1 = 0.05,
  beta2 = 0.02,
): number {
  const revealedSet = new Set(trace.revealed);
  const revealed = tree.nodes.filter((n) => revealedSet.has(n.id));
  if (revealed.length === 0) return 0;

  const quality = Math.max(...revealed.map((n) => n.reward));
  const n = revealed.reduce((sum, n) => sum + Math.max(0, n.costSteps), 0);
  const k = Math.max(1, trace.rounds);
  return quality - beta1 * n + beta2 * (n / k);
}

/**
 * A simple recorded trace: reveal up to `maxNodes` accepted-then-best nodes
 * (greedy by reward among leaves). Used when a candidate policy only chooses
 * "how many / which modules" and we do not re-run anything.
 */
export function greedyReplayTrace(tree: DiscoveryTree, maxNodes: number): ReplayTrace {
  const byReward = [...tree.nodes].sort((a, b) => b.reward - a.reward);
  const revealed: string[] = [];
  for (const n of byReward) {
    if (revealed.length >= maxNodes) break;
    if (n.reward > -100) revealed.push(n.id); // skip hard fails
  }
  return { revealed, rounds: Math.min(maxNodes, Math.max(1, revealed.length)) };
}

export interface ExplorationPolicy {
  id: string;
  /** Max attempts (nodes) to open per online episode. */
  maxAttempts: number;
  /** Prefer sampling this many distinct modules before deepening one. */
  moduleSpread: number;
}

/**
 * Mean replay V of an exploration policy across a history of trees.
 * Dream-RSI averages over worlds; we average over archived episode trees.
 */
export function meanReplayValue(
  policy: ExplorationPolicy,
  history: DiscoveryTree[],
  beta1 = 0.05,
  beta2 = 0.02,
): number {
  if (!history.length) return 0;
  let sum = 0;
  for (const tree of history) {
    const trace = greedyReplayTrace(tree, policy.maxAttempts);
    sum += replayScore(tree, trace, beta1, beta2);
  }
  return sum / history.length;
}

/**
 * Monotone selection (Dream-RSI): pick the best policy among candidates
 * ∪ {incumbent}, so the new policy is never worse on the fixed history.
 */
export function selectExplorationPolicy(
  candidates: ExplorationPolicy[],
  incumbent: ExplorationPolicy,
  history: DiscoveryTree[],
  beta1 = 0.05,
  beta2 = 0.02,
): { chosen: ExplorationPolicy; scores: Record<string, number> } {
  const pool = [incumbent, ...candidates.filter((c) => c.id !== incumbent.id)];
  const scores: Record<string, number> = {};
  let chosen = incumbent;
  let best = -Infinity;
  for (const p of pool) {
    const v = meanReplayValue(p, history, beta1, beta2);
    scores[p.id] = v;
    if (v > best) {
      best = v;
      chosen = p;
    }
  }
  return { chosen, scores };
}
