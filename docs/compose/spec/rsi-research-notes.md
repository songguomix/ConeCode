# RSI Mode Research Notes (ConeCode)

## 2026-11-18 · 有限预算下怎样判断一次改动值得保留

检索范围是公开的编码代理、外部验证、候选搜索与持续自改进研究。为扩大覆盖面，参考了一项按固定检索式审阅 114 篇研究的综述，再针对本项目的运行决策核对下列原始论文。该综述发现，在 26 篇声称改进流程本身更强的研究里，只有 4 篇从相同初始产物出发、在相同预算下比较新旧流程。这也限定了本项目能从测试中得出的结论。[综述与检索方法](https://arxiv.org/html/2610.27610v1)

| 研究问题 | 原始研究给出的证据 | ConeCode 的取舍 |
| --- | --- | --- |
| 何时付出完整验证成本 | AlphaEvolve 先用小规模测试筛选，再运行昂贵评估。Agentless 在仓库修复中采用定位、修复和验证三个阶段。 | 先做能区分假设的低成本检查。收尾时，逐项核对冻结命令，只补当前版本缺失的证据。[AlphaEvolve §2.4](https://arxiv.org/html/2506.13131v1) · [Agentless](https://arxiv.org/abs/2407.01489) |
| 何时更换思路 | SWE-Search 探索替代路径。自修复对照实验发现，计入成本后，反复修复的收益随任务和反馈质量变化。 | 默认沿一条路径工作。不同修复反复得到相同的完整诊断时，要求改换因果假设，并限制继续尝试的次数。[SWE-Search](https://arxiv.org/abs/2410.20285) · [Is Self-Repair a Silver Bullet?](https://arxiv.org/abs/2306.09896) |
| 怎样保留备选并决定晋升 | DGM 用实验档案探索不同分支。GEPA 用执行轨迹诊断，并保留具有互补表现的候选。 | 备选可在 Pareto 前沿中进出。已采用版本的实测向量单独保存，下一轮始终与它比较。[DGM](https://arxiv.org/abs/2505.22954) · [GEPA §3.1](https://arxiv.org/html/2507.19457v2) |
| 总分提高会漏掉什么 | 一项对 16 个演化代理的研究观察到，每个代理都解决了部分新任务，也丢失了部分原有覆盖。RRSI 研究了同分布收益向其他基准迁移时的衰减。 | 把收益指标和回归检查都写入冻结目标。某一项通过、某个评委给高分，均不足以补齐缺失的验证。[Beneath the Surface](https://arxiv.org/abs/2611.07624) · [RRSI](https://arxiv.org/abs/2609.24972) |
| 是否默认扩大搜索 | CodeMonkeys 在 SWE-bench 上研究了串行、并行采样与选择。Dream-RSI 利用已实现的探索轨迹回放策略。另一项持续任务流实验发现，部分昂贵 RSI 方法的准确率可被轻量笔记法追平。 | 保留按需探索与历史回放。收尾和归档判断只使用本次执行或对应候选的实测证据，不为每轮增加模型调用。[CodeMonkeys](https://arxiv.org/abs/2501.14723) · [Dream-RSI](https://arxiv.org/abs/2609.14858) · [The RSI Tax](https://arxiv.org/abs/2611.13524) |

### 已实现的判断规则

1. 聊天执行器按当前代码修订、工作目录、命令参数累计冻结检查的结果。产品修改会使上一版的通过记录失效。同一版上已经通过的单项可以复用。原生性能检查使用工具提供的采样结果。
2. 同一检查在两次修复后仍给出同一份完整诊断时，运行器提示重新定位原因。第三次修复仍无变化就停止；新的诊断或通过的复验会结束旧的连续计数。两次提前收尾的恢复机会沿用现有设置。这些次数是工程默认值。
3. 候选判决器独立保存已采用版本的归一化实测值。旧存档可从同一候选的历史记录恢复。缺乏可比的实测值时保留现有版本。实测收益与回归约束仍由冻结目标定义。
4. 每次 RSI 执行在命令验证通过后，用官方 `auto_screenshot` 截取交付界面。逻辑改动可展示真实命令输出。如果模型直接收尾，前台运行器会补截一次，并把图片交给模型查看。后续改动或重新验证会使先前的截图失效。插件失败、无法读取图像或获取了错误目标时，运行保持未完成。

### 同输入对照

以下结果记录于加入最终截图要求之前，衡量命令检查的判定。以仓库保存的 2026-11-08 安装器修复目标为契约，其中包含两文件定向测试、类型检查、全量测试和性能快照四项。将同一组模拟工具事件分别输入修改前后的聊天监视器，每组只在末尾请求一次收尾。

| 轨迹 | 数量 | 旧版判对 | 新版判对 |
| --- | ---: | ---: | ---: |
| 四项齐全、齐全后只写归档、改动后重新跑齐 | 3 | 3 | 3 |
| 仅跑类型检查、遗漏性能快照、全量测试在另一项目运行、定向测试只跑一个文件、改动后只重跑类型检查 | 5 | 0 | 5 |
| 全量测试失败 | 1 | 1 | 1 |

两版都能识别完整和明确失败的执行。五条证据不足的轨迹在旧版均被标记完成，新版均要求补验。此对照测量的是固定案例上的判定准确性。真实任务成功率和每个成功任务的成本，需要相同项目快照、模型和预算下的多次端到端对照才能估算。

## Earlier design notes

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
