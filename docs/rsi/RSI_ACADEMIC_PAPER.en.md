# Bounded Anchored Recursive Self-Improvement for Desktop Coding Agents: Program-Owned Gates, Discovery-Tree Offline Replay, and Runtime Evidence Closure

---

## Abstract

As large language model (LLM) coding agents take on long-horizon software maintenance and autonomous iteration, bringing Recursive Self-Improvement (RSI) into real-world desktop repositories confronts four structural failure modes: goal drift from unanchored self-evaluation, benchmark overfitting and reward hacking, security contamination under score pressure, and prohibitive online verification costs. This paper formalizes the **Bounded, Anchored Recursive Self-Improvement (RSI+RL)** architecture implemented in ConeCode, an open-source desktop AI coding workspace. The central principle of our design is a strict separation between LLM-driven hypothesis generation and program-owned adjudication: deterministic, unit-tested software gates—rather than prompt prose—enforce frozen goal vectors, pre-mutation candidate validation, positive-existence workspace snapshotting and rollback, cheapest-first verification cascades, Pareto non-dominated frontier retention, slow registration, cost-lock circuit breaking, and multimodal visual acceptance closure. To amortize online exploration costs without fabricating product evidence, every online attempt (including rejected and rolled-back candidates) is persisted as an append-only discovery tree and replayed offline through a dependency-aware DREAM policy selector with monotone non-regression guarantees. Evaluated across 21 automated contract test suites (259 tests) and a controlled fixed-trajectory comparison on a real repository goal contract, the runtime evidence monitor raises detection accuracy on under-verified trajectories from 0% to 100%, demonstrating that program-owned invariants make desktop RSI auditable, cost-bounded, and safe.

**Keywords**: Recursive Self-Improvement (RSI); Anchored Evaluation; Coding Agents; Pareto Frontier; Discovery-Tree Replay; Runtime Evidence Closure

---

## 1. Introduction

LLM-based software engineering agents have progressed from single-turn code completion to multi-step autonomous systems capable of planning, tool execution, and iterative debugging. A natural frontier is Recursive Self-Improvement (RSI), in which an agent iteratively improves both the target codebase and its own project-level workflow harness while solving real tasks. However, deploying open-ended self-improvement inside live desktop repositories introduces acute engineering and safety hazards that rarely surface in offline algorithmic benchmarks:

1. **Goal Drift and Self-Referential Scoring**: Allowing a model to judge its own progress—or to accept flattering LLM judge scores without external gains—produces illusory improvements that drift away from user intent.
2. **Benchmark Overfitting and Catastrophic Forgetting**: Optimizing a single scalar objective often masks regressions on secondary metrics or incentivizes brittle, single-fixture hacks and test-denominator manipulation.
3. **Persistent Security Contamination**: Under strong benchmark pressure, self-modifying loops can discover shortcuts that weaken validation, disable authentication/TLS checks, or bypass sandboxes, and subsequently persist those unsafe habits into long-term memory.
4. **Verification Churn and Cost Explosion**: Running compilation, full test suites, and multi-panel reviews on every candidate is expensive; without early-exit cascades, repeated-diagnostic circuit breakers, and explicit budget bounds, autonomous loops quickly burn time and API spend without measurable progress.

To address these challenges, this paper formalizes ConeCode's **Bounded, Anchored RSI+RL** architecture. Our main technical contributions are fourfold:

- **Program-Owned Adjudication and Separation of Powers**: We decouple LLM-driven proposal/editing from deterministic, unit-tested software gates governing goal freezing, candidate validation, snapshotting, rollback, scoring, slow registration, and stopping.
- **Externally Anchored Reward Shaping with Decoupled Pareto Retention**: We design a scale-normalized, hard-floor-protected composite reward, trimmed-mean multi-panel judge calibration with global discipline veto, an anti-flattery measured-gain promotion requirement, and independent persistence of the incumbent's measured vector alongside a non-dominated Pareto archive.
- **Dependency-Aware DREAM Offline Policy Replay**: We formulate an offline discovery-tree replay objective using topological dependency-aware batch rounds and safety-filtered node rewards, coupled with evidence thresholds and monotone non-regression policy selection.
- **Runtime Evidence Monitor and Multimodal Visual Closure**: We introduce a live tool-evidence state machine that tracks frozen checks by product revision number, effective working directory, and an exit-preserving shell subset, paired with repeated-diagnostic circuit breaking and pixel-verified `auto_screenshot` acceptance closure.

---

## 2. Related Work and Design Positioning

Recent literature on autonomous coding and self-improving agents spans self-modifying scaffolds, modular harness evolution, evolutionary code search, and offline policy replay. Table 1 situates our architecture relative to key prior works and documents the deliberate design trade-offs made for a desktop production environment.

| Prior Work | Core Mechanism | Adoption and Engineering Scope in Our Architecture |
| --- | --- | --- |
| **GAI** ([arXiv:2609.13406](https://arxiv.org/abs/2609.13406)) | Taxonomy of improver placement (RSI vs. GPI) and evaluation polarity (anchored / goal-drift / self-referential) | Enforces **internal improver + external anchored oracle (Anchored RSI)**; forbids self-referential scoring. |
| **Darwin Gödel Machine (DGM)** ([arXiv:2505.22954](https://arxiv.org/abs/2505.22954)) | Empirical validation, full variant archive tree, branching from promising lineages | Persists immutable discovery trees (including failed/rolled-back nodes), while forbidding host security rewrites and unbounded self-replication. |
| **ModularRSI** ([arXiv:2609.14857](https://arxiv.org/abs/2609.14857)) | Modular harness decomposition, scoped edits, success/failure contrast | Restricts each candidate to one of 6 modules (`loop`, `tools`, `observation`, `context`, `completion`, `product`). |
| **RRSI** ([arXiv:2609.24972](https://arxiv.org/abs/2609.24972)) | Regularized edit budgets and pruning of benchmark-only hacks | Applies file/line edit-cost penalties, 2× cost-budget discipline vetoes, and reusability review. |
| **AlphaEvolve** ([arXiv:2506.13131](https://arxiv.org/html/2506.13131v1)) | EVOLVE-BLOCK frozen evaluation region and cheapest-first evaluation cascades | Freezes `GOAL_VECTOR.md` via hash and path guards; runs early-exit verification cascades. |
| **GEPA** ([arXiv:2507.19457](https://arxiv.org/html/2507.19457v2)) | Execution-trace reflection, Pareto retention, calibrated judging | Implements four-way archive verdicts, non-dominated Pareto pruning, and trimmed-mean judge calibration. |
| **Dream-RSI** ([arXiv:2609.14858](https://arxiv.org/abs/2609.14858)) | Discovery-tree world model for offline monotone exploration-policy improvement | Adds dependency-aware batch rounds and safety filtering while strictly separating replay scores from product verification. |
| **SEAL / MedRSI** ([SEAL](https://arxiv.org/abs/2506.10943)) | Trial-and-error self-edits with retention checks; fast discovery, slow registration | Enforces `retentionPassed` anti-forgetting hard rejection and `slowRegisterGate` for persistent logs. |
| **Trusting Trust Revisited** ([arXiv:2609.17817](https://arxiv.org/abs/2609.17817)) | Demonstrates persistent security regressions induced by poisoned benchmarks | Embeds immutable safety invariants, global discipline vetoes, and regex contamination filtering on persistent lessons. |
| **Agentless / SWE-Search / Self-Repair / CodeMonkeys / The RSI Tax / Beneath the Surface** ([Agentless](https://arxiv.org/abs/2407.01489), [SWE-Search](https://arxiv.org/abs/2410.20285), [Self-Repair](https://arxiv.org/abs/2306.09896), [CodeMonkeys](https://arxiv.org/abs/2501.14723), [The RSI Tax](https://arxiv.org/abs/2611.13524), [Beneath the Surface](https://arxiv.org/abs/2611.07624)) | Staged localization/repair/verification, cost-normalized self-repair limits, coverage trade-offs | Defaults to single-path targeted checks, caps repeated identical diagnostics, and stores incumbent metric vectors independently to prevent hidden regressions. |

Notably, a systematic review examining 114 studies ([arXiv:2610.27610](https://arxiv.org/html/2610.27610v1)) found that among 26 works claiming improved self-improvement processes, only 4 compared old and new processes from identical initial artifacts under matched budgets. This empirical finding motivates our explicit stopping semantics: stopping under finite resources is always reported as **budget-limited local convergence**, never as a proof of global optimality.

---

## 3. Problem Formulation and Safety Invariants

Let $\mathcal{W}$ denote the open workspace filesystem state. A frozen task contract is defined as the tuple:
$$\mathcal{G} = \langle C, \mathcal{M}, t_0, \mathcal{N} \rangle$$
where $C$ is the user charter goal, $\mathcal{N}$ specifies non-goals and scope boundaries, and $\mathcal{M} = \{m_1, \dots, m_k\}$ ($2 \le k \le 5$) is the set of frozen external metrics. Each metric $m_i = \langle \text{id}_i, \text{cmd}_i, d_i \in \{\uparrow, \downarrow\}, b_i, s_i, \underline{\delta}_i \rangle$ binds a stable identifier, an executable external command, an optimization direction, a finite initial baseline $b_i \in \mathbb{R}$ frozen during ASSESS, a positive normalization scale $s_i > 0$, and an optional hard regression floor $\underline{\delta}_i$.

Let $\mathcal{F} \subset \mathcal{W}$ denote the frozen evaluation region (EVOLVE-BLOCK), comprising `.conecode/rsi/GOAL_VECTOR.md` and per-conversation goal files. A candidate proposal is declared prior to mutation as:
$$c = \langle \text{id}, \mu \in \mathcal{U}, h, \mathcal{S}, (T, D), (F_{\max}, L_{\max}), B_{\$} \rangle$$
where $\mathcal{U} = \{\text{loop}, \text{tools}, \text{observation}, \text{context}, \text{completion}, \text{product}\}$, $\mathcal{S}$ is the set of declared success criteria, $(T, D)$ are the declared `touch` and `doNotTouch` path sets, $(F_{\max}, L_{\max})$ is the edit budget, and $B_{\$}$ is the per-episode cost budget.

The program layer enforces four formal invariants across every episode:
- **I1 (Goal Freeze Invariance)**: Let $h_0 = H(\text{GOAL\_VECTOR.md})$. Every candidate must observe $H(\text{GOAL\_VECTOR.md}) = h_0$ before mutation and before verification; any mismatch halts the loop and rolls back uncommitted edits.
- **I2 (Workspace & EVOLVE-BLOCK Containment)**: For every $p \in T$, its normalized path satisfies $\text{norm}(p) \subseteq \mathcal{W}$ and $\text{norm}(p) \cap (\mathcal{F} \cup D) = \emptyset$.
- **I3 (External Verifiability)**: Every criterion $s \in \mathcal{S}$ must assert $s.\text{external} = \text{true}$, the verification cascade must be non-empty, and all required frozen metrics must yield finite measured deltas.
- **I4 (Safety Non-Regression & Anti-Contamination)**: A zero discipline score (from any judge panel) vetoes the candidate unconditionally, and any reflection lesson matching security-weakening patterns is rejected from persistent storage.

---

## 4. Architecture and Methodology

### 4.1 Decoupled Pure Core and Per-Conversation Isolation

To guarantee auditability and renderer compatibility, all core RSI algorithms are implemented as pure TypeScript modules with dependency-injected filesystem I/O (`RsiFs`), decoupled from Electron IPC and UI components. Each RSI conversation owns an isolated archive directory `.conecode/rsi/conversations/<safeId>/` containing `GOAL_VECTOR.md`, `BASELINE.json`, `LOOP_STATE.json` (`version: 1`), append-only discovery trees (`trees/<episode>.json`), write-once iteration records (`iterations/<id>.md`), `EVOLUTION_LOG.md`, `REFLECTIONS.md`, and `STRATEGY.md`.

### 4.2 Externally Anchored Composite Reward and Calibrated Judging

After external verification produces $e = \langle p_{\text{ext}}, \{\Delta_i\}_{i=1}^k, \mathbf{j}, F, L \rangle$, raw signed improvements are defined as $\Delta_i = v_i - b_i$ for $d_i = \uparrow$ and $\Delta_i = b_i - v_i$ for $d_i = \downarrow$. Defining scale-normalized deltas $\tilde{\Delta}_i = \Delta_i / \max(s_i, 10^{-9})$ and normalized weights $\tilde{w}_i = w_i / \max_j w_j$, the composite scalar reward is:
$$R(e) = \begin{cases}
-999, & \text{if } \neg p_{\text{ext}} \lor \neg\text{valid}(\mathbf{m}) \lor \exists i\,(\tilde{\Delta}_i < \underline{\delta}_i) \lor F < 0 \lor L < 0 \\
1.2 \cdot \bar{M}(e) + 0.8 \cdot \bar{J}(\mathbf{j}) - P_{\text{cost}}(F, L), & \text{otherwise}
\end{cases}$$
where:
$$\bar{M}(e) = \frac{\sum_{i=1}^{k} \tilde{w}_i \tanh(\tilde{\Delta}_i)}{\sum_{i=1}^{k} \tilde{w}_i}, \quad \bar{J}(\mathbf{j}) = \frac{1}{3}\sum_{u \in \{a,s,d\}} \text{clip}_{[0,1]}(j_u)$$
$$P_{\text{cost}}(F, L) = 0.25\left(\frac{\max(0, F-6)}{6} + \frac{\max(0, L-400)}{400}\right)$$

The $\tanh$ saturation bounds each normalized axis within $(-1, 1)$, preventing a single large-magnitude metric from drowning out other frozen objectives, while hard floors $\underline{\delta}_i$ prevent no-regression guards from being traded away for speedups.

**Multi-Panel Judge Calibration**: Given $P$ independent read-only judge panels $\{\mathbf{j}^{(1)}, \dots, \mathbf{j}^{(P)}\}$, if any panel assigns $\text{clip}_{[0,1]}(j_d^{(p)}) \le 0$, the aggregated discipline score is forced to $0$ (global veto). Otherwise, for $P \ge 3$, each axis uses the trimmed mean (dropping the minimum and maximum scores) to dampen single-judge drift.

**Anti-Flattery Promotion Rule**: Let $\tilde{\boldsymbol{\Delta}}^{\star}$ denote the incumbent's scaled delta vector ($\mathbf{0}$ prior to the first accepted candidate). Promoting a candidate over the incumbent requires:
1. Clearing all external, floor, and discipline gates with an identical metric key set to $\tilde{\boldsymbol{\Delta}}^{\star}$;
2. **Strict Measured Gain**: $\exists i \in \{1,\dots,k\},\, \tilde{\Delta}_i > \tilde{\Delta}^{\star}_i + \epsilon$ ($\epsilon = 10^{-3}$);
3. **Strict Composite Improvement**: $R(e) > R^{\star} + \epsilon$.

Consequently, a more lenient judge panel can never promote a candidate whose external metrics are equal or uniformly worse than the incumbent.

### 4.3 Pareto Non-Dominated Retention and Decoupled Incumbent Anchoring

Candidate $a$ Pareto-dominates candidate $b$ ($a \succ b$) iff they share the exact same finite metric key set, $\forall i,\, \tilde{\Delta}_i^{(a)} \ge \tilde{\Delta}_i^{(b)}$, and $\exists j,\, \tilde{\Delta}_j^{(a)} > \tilde{\Delta}_j^{(b)}$. The four-way archive selector (`selectForArchive`) assigns each candidate one of three actions:
- **`replace-best`**: Satisfies Section 4.2 promotion criteria; replaces the incumbent and enters the frontier.
- **`retain-frontier`**: Trails the incumbent's scalar reward, passes all hard gates, exhibits a positive gain ($>\epsilon$) over the fixed baseline on at least one axis, is not $\epsilon$-equivalent to any existing archive node, and is not dominated by any archive member. Retained in the Pareto archive $\mathcal{A}$ (with newly dominated members pruned) while the workspace rolls back to the incumbent.
- **`reject`**: Duplicate ID, hard violation, no positive gain, frontier-equivalent, or dominated.

Crucially, `state.best.metrics` is persisted independently of `state.archive`. If a high-edit-cost candidate dominates the incumbent on every metric axis—entering $\mathcal{A}$ and pruning the incumbent from the frontier—subsequent comparisons still retain the incumbent's exact measured vector.

### 4.4 Program-Owned Episode Loop and Positive-Existence Rollback

Algorithm 1 formalizes the deterministic single-episode control flow shared across the synchronous orchestrator (`rsiEpisode.ts`) and the asynchronous Electron bridge (`verifyAndAdjudicate` in `rsiBridge.ts`):

```text
Algorithm 1: Program-Owned Bounded RSI Episode
Input:  LoopState S, Candidate c, GoalHash h0, SnapshotHandle snap, StopConfig cfg
Output: LoopState S', Verdict v, RollbackReport rb

1. if c.id ∈ S.seenIds then return (S, duplicate)
2. if S.stopped ∨ evaluateStop(S, cfg).shouldStop then
       rb ← rollbackWorkspace(snap); S.stopped ← true; persist(S)
       return (S, preempted="loop-stopped", rb)
3. if hashContent(GOAL_VECTOR.md) ≠ h0 then
       rb ← rollbackWorkspace(snap); S.stopped ← true; persist(S)
       return (S, preempted="goal-vector-mutated", rb)
4. if validateCandidate(c, S.goal, W) ≠ ∅ then
       rb ← rollbackWorkspace(snap); S1 ← recordInvalid(S, c, reward=-999)
       if evaluateStop(S1, cfg).shouldStop then markStopped(S1)
       persist(S1); return (S1, preempted="invalid-declaration", rb)
5. Execute mutation within sandbox; detect undeclared creations via parent-dir diff
6. cascade ← runVerifyCascade(stages)                  // cheapest-first, early-exit
7. (deltas, missing) ← buildMetricDeltas(bindings, baseline, cascade.stages)
8. effectivePass ← cascade.passedAll ∧ (missingRequired = ∅) ∧ (retentionPassed ≠ false)
9. if costUsd > 2 · c.costBudgetUsd ∧ effectivePass then judges.discipline ← 0
10. outcome ← recordEpisodeOutcome(S, c, effectivePass, deltas, costUsd)
11. if outcome.mustRollback then rb ← rollbackWorkspace(snap, undeclaredCreations)
12. Persist discovery-tree node (idempotent) & iteration markdown (write-once)
13. if outcome.verdict = replace-best ∧ slowRegisterGate(outcome.state) then
        appendEvolutionLog(...)
14. stop ← evaluateStop(outcome.state, cfg); if stop.shouldStop then markStopped()
15. Persist LOOP_STATE.json and return (S', outcome.verdict, rb)
```

To prevent silent data loss over desktop IPC bridges that map read errors to `null` or `[]`, `snapshotWorkspace` enforces **positive proof of absence**: a path is marked absent only when `pathExists` returns an explicit `false`. Any indeterminate status aborts snapshotting before mutation. Furthermore, CLI output parsers (`parseVitestSummary`, `parseTscOutput`) strip ANSI SGR escape sequences prior to extraction so colored terminal streams never distort metric counts.

### 4.5 Dependency-Aware DREAM Offline Replay and Monotone Policy Selection

To reduce online verification expense, the DREAM phase (`rsiReplay.ts`) evaluates candidate exploration policies $\pi = (N_{\max}, \text{spread}, W)$ offline over historical discovery trees $\mathcal{H} = \{\tau_1, \dots, \tau_m\}$ without re-executing tests. To prevent inflated parallelism $W$ from fabricating speedups over serial parent-child histories, Algorithm 2 computes dependency-aware batch rounds:

```text
Algorithm 2: Dependency-Aware Replay Rounds and Policy Scoring
Input:  DiscoveryTree τ, ExplorationPolicy π = (N_max, spread, W), β1=0.05, β2=0.02
Output: ReplayScore (maxReward, N, rounds, V)

1. revealed ← τ.nodes[0 .. min(N_max, |τ.nodes|) - 1]; N ← |revealed|
2. pending ← copy(revealed); completed ← ∅; rounds ← 0
3. while pending ≠ ∅ do
       ready ← first W nodes v ∈ pending such that (v.parentId = null ∨ v.parentId ∈ completed)
       if ready = ∅ then rounds ← N; break          // malformed lineage: no batching claim
       completed ← completed ∪ {v.id | v ∈ ready}
       pending ← pending \ ready; rounds ← rounds + 1
4. rounds ← max(1, rounds)
5. valid ← {v ∈ revealed | v.externalPass ∧ v.status ≠ "failed" ∧ baseReason(v) ∉ INVALID_REASONS}
6. maxReward ← max({v.reward | v ∈ valid} ∪ {-999})
7. V ← (N = 0 ? -999 : maxReward) - β1 · N + β2 · (N / rounds)
```

Here `baseReason(v)` strips composite suffixes (such as `+rollback-errors`) so safety-vetoed or budget-exceeded nodes never contribute rewards to replay. Policy selection (`selectExplorationPolicy`) enforces two guarantees:
- **Thin-History Guard**: When $|\mathcal{H}| < 2$ or $\sum |\tau_i| < 4$, the incumbent policy is retained with `evidenceSufficient = false`.
- **Monotone Non-Regression**: Because the incumbent always competes and wins ties, a challenger deploys to `STRATEGY.md` only if $\bar{V}(\pi') > \bar{V}(\pi_{\text{inc}}) + 10^{-6}$, guaranteeing non-regression on fixed history.

### 4.6 Runtime Evidence Monitor and Multimodal Visual Closure

Within the live agent loop (`chat.store.ts`), `RsiExecutionMonitor` (`rsiRuntime.ts`) enforces runtime evidence closure independently of assistant text:
1. **Exit-Preserving Shell Subset & Directory Scoping**: Rejects pipes, redirections, and subshells that can hide failing exit codes, normalizing each check to `(effectiveCwd, command)` tuples.
2. **Product Revision Invalidation**: Any non-archive write or unknown `exec` increments `revision`, invalidating prior check passes and screenshot reviews while exempting `.conecode/rsi/**` bookkeeping.
3. **Repeated-Diagnostic Circuit Breaking**: Halts execution after 3 consecutive failures of the same tool without code edits, or 3 distinct repairs producing the exact same complete diagnostic (prompting a hypothesis switch after 2).
4. **Multimodal Visual Acceptance**: Once all frozen checks pass on the current revision, premature completion text is intercepted and a program-requested `auto_screenshot` capture is executed (checking foreground ownership, target match, and vision capability). Only after the next model turn receives that capture's pixels and confirms review (`confirmScreenshotReview(ticket)`) does `finish()` return `'complete'`.

### 4.7 Slow Registration, Contamination-Filtered Reflections, and Local Stopping

- **Slow Registration (`slowRegisterGate`)**: Persists wins to `EVOLUTION_LOG.md` only after $\ge 2$ independent accepted episodes or explicit user approval with $\ge 1$ accepted win.
- **Anti-Contamination Reflections (`REFLECTIONS.md`)**: Regex filters block any lesson advocating weakened checks or bypassed security; valid lessons use monotonically unique IDs (`maxSeq + 1`), reinforce duplicates by appending `episodeId`, cap history at 30 entries, and are injected as escaped untrusted JSON inside `<rsi-history-data>`.
- **Crash Recovery (`recoverLoopState`)**: Automatically rebuilds an equivalent `LoopState` from persisted discovery trees if `LOOP_STATE.json` is missing or corrupted.
- **Budget-Limited Local Convergence (`evaluateStop`)**: Combines user interrupts, unverifiable oracles, 2 consecutive hard fails, episode caps, 2× cost-lock and 4× hard spend caps, 3-streak repeated failure classes, and 3-episode non-improving local plateaus (flagging narrow module concentration when $\ge 75\%$ of the last 4 attempts target one module).

---

## 5. Implementation and Empirical Evaluation

### 5.1 Automated Contract Verification Matrix

All RSI modules pass TypeScript strict checking (`tsc -p tsconfig.check.json` with zero RSI errors) and are verified by **21 test suites totaling 259 automated tests** (Node v24.19.0 + Vitest 4.1.11, completing in `1.16s`), summarized in Table 2.

| Verification Layer | Core Modules | Suites | Tests | Contracts Verified |
| --- | --- | ---: | ---: | --- |
| Reward & Pareto Core | `rsiReward.ts` | 2 | 35 | Hard gates, per-metric scaling, regression floors, anti-flattery promotion, trimmed-mean panels, Pareto dominance/pruning, `NaN` safety |
| Loop, Orchestrator & Bridge | `rsiLoop.ts`, `rsiEpisode.ts`, `rsiBridge.ts` | 4 | 50 | Workspace & EVOLVE-BLOCK guards, positive-existence snapshots & undeclared rollback, stop boundaries, anti-forgetting & budget gates |
| Verification & Runtime Monitor | `rsiVerify.ts`, `rsiRuntime.ts`, `rsiHistory.ts` | 3 | 55 | Early-exit cascades, ANSI stripping, multilingual goal tables, revision invalidation, repeated-diagnostic stops, screenshot-ticket closure |
| Trees, Persistence & DREAM | `rsiTree.ts`, `rsiPersistence.ts`, `rsiReplay.ts`, `electron/rsi/store.ts` | 4 | 27 | Idempotent append, tree-based crash recovery, contamination filtering, monotonic lesson IDs, dependency-aware replay, real disk I/O |
| Host Loop & UI Integration | `chat.store.ts`, `rsiConversation.ts`, `rsiStart.ts`, `components/rsi/*` | 8 | 92 | Execution authorization, cost-lock stops, automatic screenshot review, per-conversation isolation, macOS permission gating, layout isolation |
| **Total** | **Full RSI Subsystem** | **21** | **259** | **100% passing (1.16s)** |

### 5.2 Controlled Fixed-Trajectory Runtime Comparison

To evaluate runtime closure on realistic agent traces, we reference the controlled comparison recorded in `docs/compose/spec/rsi-research-notes.md` using a real repository goal contract (the 2026-11-08 installer-fix contract specifying two-file targeted tests, typecheck, full test suite, and `perf_snapshot`). Nine identical simulated tool-event trajectories were replayed through the baseline and revised monitors with a single completion request at the end:

| Trajectory Category | Count | Baseline Correct | Revised Correct | Analysis |
| --- | ---: | ---: | ---: | --- |
| Complete (all 4 checks passed; archive-only writes after pass; full re-run after edit) | 3 | 3 (100%) | 3 (100%) | Both monitors correctly accept complete evidence |
| Under-verified (typecheck only; missing `perf_snapshot`; full tests in wrong dir; only 1 targeted test file; only typecheck re-run after edit) | 5 | 0 (0%) | **5 (100%)** | Baseline falsely marked all 5 complete; revised monitor intercepted all 5 and named missing checks |
| Explicit failure (full test suite failed) | 1 | 1 (100%) | 1 (100%) | Both monitors correctly block failed suites |

Tracking frozen checks by revision, working directory, and exact command arguments eliminates all five false-completion failure modes while introducing zero false positives on complete trajectories.

### 5.3 Structural Properties

1. **Cascade Cost Savings**: Ordering cheap checks (compilation, targeted tests) before full suites and stopping on the first failure directly bounds verification cost (`costSteps`) on rejected candidates.
2. **Anti-Inflation in Offline Replay**: On any strictly serial lineage $v_1 \to v_2 \to \dots \to v_N$, Algorithm 2 yields $\text{rounds} = N$ regardless of declared parallelism $W$, locking the batching term to $\beta_2$ and preventing spurious policy switches.
3. **Lossless Crash Recovery**: Persisting every episode's outcome, base failure class, and finite scaled deltas into append-only discovery trees allows `rebuildLoopStateFromTrees` to recover an exact incumbent, Pareto frontier, and failure streak after checkpoint corruption without re-executing external commands.

---

## 6. Discussion and Limitations

Four practical boundaries merit future investigation:
1. **End-to-End Multi-Repository Benchmarks**: While contract tests and fixed-trajectory comparisons establish gate correctness, quantifying cost-normalized task resolution rates and long-horizon DREAM gains requires controlled multi-repository end-to-end runs under matched snapshots, models, and budgets.
2. **Transactional Isolation for Non-File Side Effects**: File-level snapshots and parent-directory scans cover declared paths and local creations, but deep directory mutations or external service side effects from shell commands would benefit from Git Worktree or copy-on-write filesystem isolation.
3. **Host vs. Target Performance Telemetry**: Built-in `perf_snapshot` observes the Electron host process; optimizing external target applications still requires declaring workload-specific benchmark commands in `GOAL_VECTOR.md`.
4. **Human-Gated Meta-Evolution**: Keeping protocol and invariant modifications strictly user-gated bounds autonomous meta-improvement, representing an intentional safety trade-off for production desktop tools.

---

## 7. Conclusion

This paper formalized ConeCode's Bounded, Anchored Recursive Self-Improvement (RSI+RL) architecture. By moving goal-vector freezing, scale-normalized reward shaping, calibrated multi-panel judging, decoupled Pareto retention, positive-existence snapshotting, dependency-aware DREAM offline replay, and revision-tracked visual acceptance closure into deterministic, unit-tested program gates, the system resolves the core tension between autonomy, verification economics, and safety in desktop coding agents—providing an auditable, cost-bounded blueprint for practical recursive self-improvement.

---

## References

1. Novikov, A., et al. *AlphaEvolve: A coding agent for scientific and algorithmic discovery*. [arXiv:2506.13131](https://arxiv.org/html/2506.13131v1), 2025.
2. Zhang, J., et al. *Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents*. [arXiv:2505.22954](https://arxiv.org/abs/2505.22954), 2025.
3. Agrawal, L. A., et al. *GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning*. [arXiv:2507.19457](https://arxiv.org/html/2507.19457v2), 2025.
4. Zweiger, A., et al. *Self-Adapting Language Models (SEAL)*. [arXiv:2506.10943](https://arxiv.org/abs/2506.10943), 2025.
5. Xia, C. S., et al. *Agentless: Demystifying LLM-based Software Engineering Agents*. [arXiv:2407.01489](https://arxiv.org/abs/2407.01489), 2024.
6. Antoniades, A., et al. *SWE-Search: Enhancing Software Agents with Monte Carlo Tree Search and Iterative Refinement*. [arXiv:2410.20285](https://arxiv.org/abs/2410.20285), 2024.
7. Olausson, T. X., et al. *Is Self-Repair a Silver Bullet for Code Generation?* [arXiv:2306.09896](https://arxiv.org/abs/2306.09896), 2023.
8. Ehrlich, R., et al. *CodeMonkeys: Scaling Test-Time Compute for Software Engineering*. [arXiv:2501.14723](https://arxiv.org/abs/2501.14723), 2025.
9. *Generalized Agent Iteration (GAI)*. [arXiv:2609.13406](https://arxiv.org/abs/2609.13406), 2026.
10. *ModularRSI: Modular Harness Recursive Self-Improvement*. [arXiv:2609.14857](https://arxiv.org/abs/2609.14857), 2026.
11. *Dream-RSI: Offline Discovery-Tree Replay for Exploration Policy Improvement*. [arXiv:2609.14858](https://arxiv.org/abs/2609.14858), 2026.
12. *Trusting Trust Revisited: Security Contamination in Self-Improving Agents*. [arXiv:2609.17817](https://arxiv.org/abs/2609.17817), 2026.
13. *Regularized Recursive Self-Improvement (RRSI)*. [arXiv:2609.24972](https://arxiv.org/abs/2609.24972), 2026.
14. *A Systematic Review of Recursive Self-Improvement in Coding Agents*. [arXiv:2610.27610](https://arxiv.org/html/2610.27610v1), 2026.
15. *Beneath the Surface: Coverage Trade-offs in Evolving Coding Agents*. [arXiv:2611.07624](https://arxiv.org/abs/2611.07624), 2026.
16. *The RSI Tax: Cost-Normalized Evaluation of Self-Improving Agents*. [arXiv:2611.13524](https://arxiv.org/abs/2611.13524), 2026.
