# RSI Mode Research Notes (ConeCode)

Sources consulted before redesign (2026-09-17):

| Work | ID | What we take |
|------|-----|--------------|
| Darwin Gödel Machine | arXiv:2505.22954 | Self-modify agent code; validate empirically; keep an **archive** of variants; sandbox + human oversight |
| Generalized Agent Iteration | arXiv:2609.13406 | Two dials: improver inside agent (= RSI) vs outside (= GPI); **polarity**: anchored / goal drift / fully self-referential. Design target = **anchored** |
| ModularRSI | arXiv:2609.14857 | Evolve harness in **modules** (loop / tools / observation / context / completion); restricted scope; contrast success vs failure; benchmark-disjoint |
| RRSI | arXiv:2609.24972 | Regularize proposal budget; critic + pruner; prefer reusable mechanisms over benchmark hacks |
| Trusting Trust revisited | arXiv:2609.17817 | Poisoned benchmarks → agent evolves insecure code (e.g. disable TLS verify); contamination **persists**. Defend: never evolve security-weakening behavior |
| Live-SWE-agent | arXiv:2511.13646 | Evolve scaffold **while solving real tasks**, not only offline eval loops |
| MedRSI | arXiv:2609.24838 | **Fast discovery, slow registration** into the persistent agent |
| The Last AI Built by Humans | arXiv:2609.11873 | Autonomy ladder: execution → strategy → experience → environment → meta. Product RSI stops before unbounded meta |
| AlphaEvolve | arXiv:2506.13131 | **EVOLVE-BLOCK** (frozen eval region, mutable solution region); **evaluation cascade** (stages of increasing cost, early exit); MAP-Elites program database balancing exploration/exploitation; failure insights fed back |
| Absolute Zero | arXiv:2505.03335 | Proposer+solver self-play; **learnability reward** (maximal signal where the solver sometimes passes); code executor as unified verifier; deduction/abduction/induction modes |
| SEAL | arXiv:2506.10943 | **Trial-and-error self-edits** (sample several, keep the best by downstream utility); lightweight updates; **retention checks** vs catastrophic forgetting |
| GEPA | arXiv:2507.19457 | Reflect on full execution traces (**ASI** as textual gradient); **Pareto retention** (best-per-instance, not global best); **system-aware merge** of complementary candidates; minibatch-then-full evaluation |

## Definition used in ConeCode

**Bounded, anchored harness/product RSI**: the agent may propose and apply small, module-scoped modifications to the *open workspace* (product code, tests, project harness: AGENTS.md / skills / commands / docs), with **external** commands and the user charter as the only success oracle. The improving mechanism is part of the agent run (true RSI, not a human-in-the-loop GPI), but evaluation is **anchored** outside the agent.

Not in scope: model weights, host app outside the workspace, weakening safety rails, recursive rewriting of the RSI protocol itself (meta-improvement is user-gated).

## Failure modes we design against

1. **Goal drift / self-referential scoring** (GAI) — success defined by "I think it is better".
2. **Benchmark overfit / reward hacking** (RRSI, ModularRSI) — edits that only green one fixture.
3. **Security contamination** (Trusting Trust) — self-mod disables TLS/auth/sandbox to "pass".
4. **Monolithic blast radius** (ModularRSI) — whole-harness rewrites with no attribution.
5. **Infinite churn** (economics of RSI) — loops that burn tokens without metric movement.
