# Dream-RSI (arXiv:2609.14858) — takeaways for ConeCode RSI+RL

## What the paper does

Three-stage meta-RL over *exploration policy* (not the product):

1. **Online Explore** — fixed coding agent + fixed evaluator; exploration policy decides which discovery-tree leaves to expand (batch size = parallel workers W), when to open a new branch from root, when to stop.
2. **Construct Replay Simulator** — each finished online run is a **discovery tree** (root = initial workspace; node = attempt with score s_v, filesystem snapshot, diagnostics). History ℋ = forest of trees.
3. **Dreaming-based Policy Improvement** — candidate exploration policies replay over recorded trees (no re-execution). Score:

   V = max_v s_v  −  β₁ · N  +  β₂ · N / max(1, k)

   (quality − attempt cost + parallelism bonus). Average V over all historical trees; keep argmax policy (current policy is always in the candidate set ⇒ never worse). Redeploy online; history grows.

## Why it matters for us

Our RSI+RL currently samples **one product/harness candidate per episode** and scores it online (expensive: real tests + judge panel). Dream-RSI says:

- Treat **rejected and accepted attempts** as a tree, not a flat log.
- Improve the **exploration policy** (which module next, budget, serial vs parallel samples, when to stop) offline on that tree.
- Use a quality−cost(+parallelism) objective so we do not burn tokens on thrash.
- Selection is **monotone**: never deploy an exploration policy worse on replay than the incumbent.

## Mapping to ConeCode

| Dream-RSI | ConeCode RSI+RL |
|-----------|-----------------|
| Discovery tree | `.conecode/rsi/trees/<run>.json` — parent = policy state (accepted head), child = candidate attempt (accepted/rejected, reward, judges, metrics) |
| Evaluator score s_v | `computeReward` (external gate + judges − cost) — already exists |
| Exploration policy | Which module / editBudget / sample order / when to DREAM vs EXECUTE |
| Replay simulator | Offline: walk recorded children only; no re-run of tests |
| Dreaming | Before next online sample, propose 2–3 exploration-policy tweaks and score them on history |
| V formula | `replayScore` in `rsiReplay.ts` |
| Monotone policy select | Keep exploration policy with best mean replay V; never regress |

## What we deliberately do NOT copy

- Replacing the external gate with replay max-score alone (replay is for *policy* selection; product acceptance still needs VERIFY).
- Infinite parallel workspaces — ConeCode budgets W≤3 sample branches.
- Changing the coding agent / evaluator mid-search (fixed oracle).
