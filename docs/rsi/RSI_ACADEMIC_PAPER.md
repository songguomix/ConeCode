# 有界锚定式桌面软件递归自我改进：程序化门控、发现树离线回放与运行时证据闭环

**Bounded Anchored Recursive Self-Improvement for Desktop Coding Agents: Program-Owned Gates, Discovery-Tree Offline Replay, and Runtime Evidence Closure**

---

## 摘要

大语言模型编码智能体正逐步承担长周期软件维护与自主演进任务，但将递归自我改进（Recursive Self-Improvement, RSI）引入真实桌面代码库面临四类核心挑战：缺乏外部真值导致的目标漂移（Goal Drift）、针对单一样例的基准过拟合（Reward Hacking）、指标压力诱发的安全轨退化（Security Contamination），以及高频在线验证带来的高昂计算成本。本文形式化并系统阐述了开源桌面 AI 编码工作台 ConeCode 所采用的**有界锚定式递归自我改进架构（Bounded, Anchored RSI+RL）**。该架构的核心原则是将模型的假设生成能力与系统的裁决权彻底解耦：由确定性、可单测的程序门控而非提示词文本全权掌握目标向量冻结、候选声明静态校验、正向存在性快照回滚、低成本优先验证级联、多目标 Pareto 非支配前沿保留、慢注册、成本锁熔断及多模态视觉核验闭环。进一步地，系统将每次在线尝试（包括失败与回滚节点）持久化为不可变发现树，并设计了依赖感知的 DREAM 离线回放与单调策略选择机制，在不重跑外部测试、不伪造产品证据的前提下优化后续在线探索策略。我们在 21 个测试套件（259 个自动化契约测试）以及真实冻结契约的固定轨迹对照实验上验证了系统性质：新版运行时证据监视器将 5 类证据不足轨迹的拦截准确率从 0% 提升至 100%，完整闭环在保持强安全不变量的同时实现了可审计、预算受控的自主代码演进。

**关键词**：递归自我改进（RSI）；锚定评估；编码智能体；Pareto 非支配前沿；发现树离线回放；运行时证据闭环

---

## Abstract

As large language model (LLM) coding agents assume responsibility for long-horizon software maintenance and autonomous iteration, introducing Recursive Self-Improvement (RSI) into real-world desktop repositories confronts four fundamental failure modes: goal drift from unanchored self-evaluation, benchmark overfitting and reward hacking, security contamination under score pressure, and prohibitive online verification cost. This paper formalizes the **Bounded, Anchored Recursive Self-Improvement (RSI+RL)** architecture implemented in ConeCode, an open-source desktop AI coding workspace. The central principle of our design is a strict separation between LLM-driven hypothesis generation and program-owned adjudication: deterministic, unit-tested software gates—rather than prompt prose—enforce frozen goal vectors, pre-mutation candidate validation, positive-existence workspace snapshotting and rollback, cheapest-first verification cascades, Pareto non-dominated frontier retention, slow registration, cost-lock circuit breaking, and multimodal visual acceptance closure. To amortize online exploration cost without fabricating product evidence, every online attempt (including rejected and rolled-back candidates) is persisted into append-only discovery trees and replayed offline through a dependency-aware DREAM policy selector with monotone non-regression guarantees. Evaluated across 21 automated contract test suites (259 tests) and a controlled fixed-trajectory study on a real repository goal contract, the runtime evidence monitor raises detection accuracy on under-verified trajectories from 0% to 100%, demonstrating that program-owned invariants make desktop RSI auditable, cost-bounded, and safe.

**Keywords**: Recursive Self-Improvement (RSI); Anchored Evaluation; Coding Agents; Pareto Frontier; Discovery-Tree Replay; Runtime Evidence Closure

---

## 1. 引言

基于大语言模型的编码智能体已从单轮代码补全演进为具备工具调用、多步规划与自主调试能力的工程助手。进一步地，研究者探索了让智能体在解决真实任务的过程中持续改进代码库与自身工作流支架（Harness）的递归自我改进（RSI）范式。然而，与离线算法竞赛或封闭沙箱基准不同，面向桌面端真实代码库的 RSI 必须在**改进有效性、验证经济性与安全可控性**之间取得严格平衡。实践中，缺乏程序化约束的自主改进循环极易陷入四类结构性失效：

1. **目标漂移与自指评分（Goal Drift）**：若允许模型依据自身主观判断或评委赞美判定改进成功，系统会在缺乏真实外部收益的情况下持续改写代码并产生“虚假进步”。
2. **基准过拟合与局部退化（Overfitting & Forgetting）**：单一综合标量往往会掩盖非主指标的静默退化，或诱使智能体通过削弱测试断言、新增琐碎用例来操纵指标分母。
3. **安全污染持久化（Trusting Trust Contamination）**：在强跑分压力下，自改写循环可能通过禁用校验、绕过沙箱或跳过测试来使套件变绿，并将此类有害经验沉淀至持久记忆中。
4. **无限空转与验证经济学失衡（Verification Churn）**：真实仓库的编译、全量测试与多评委审查成本高昂，缺乏早停级联、同诊断熔断与预算边界的搜索会迅速耗尽时间与费用。

针对上述问题，本文提出并形式化了 ConeCode 的**有界锚定式 RSI+RL 架构**。本文的主要技术贡献包括：
- **程序化门控与权力分离架构**：将目标冻结、候选校验、快照回滚、奖励裁决、慢注册与停机判定全部固化为可单测的确定性代码，使安全与验收边界不再依赖模型的提示词遵从度；
- **抗偏置外部锚定奖励与解耦 Pareto 保留**：设计尺度归一化与硬下界约束的复合奖励函数、多评委截尾均值校准与“实测增益硬门槛”，并将现役实测向量独立于 Pareto 前沿持久化，防止评委讨好与前沿裁剪引发的基线丢失；
- **依赖感知的 DREAM 发现树离线回放**：提出基于父子拓扑依赖的虚拟批次轮数计算与安全节点过滤规则，在严格隔离产品验收的前提下实现探索策略的单调优化；
- **运行时证据监视器与多模态视觉闭环**：构建按修订号、工作目录与安全 Shell 子集追踪冻结检查的实时监视器，结合同诊断熔断与 `auto_screenshot` 像素票据核验，杜绝“口头宣称完成”。

---

## 2. 相关工作与理论定位

近年来，自主编码与自我改进研究形成了多条技术路线。表 1 总结了代表性研究与本文架构之间的继承关系与工程取舍。

| 研究工作 | 核心机制 | 本文架构的继承与工程裁剪 |
| --- | --- | --- |
| **GAI** ([arXiv:2609.13406](https://arxiv.org/abs/2609.13406)) | 按改进器位置（RSI/GPI）与评估极性（锚定/漂移/自指）分类 | 坚持**内部改进器 + 外部锚定评估（Anchored RSI）**，禁止自指评分替代外部命令。 |
| **Darwin Gödel Machine (DGM)** ([arXiv:2505.22954](https://arxiv.org/abs/2505.22954)) | 实证验证、保留全部变体档案树、从高潜力谱系分支探索 | 保留不可变发现树档案（含失败与回滚节点），但禁止改写宿主安全轨与无限自复制。 |
| **ModularRSI** ([arXiv:2609.14857](https://arxiv.org/abs/2609.14857)) | 将支架拆分为独立模块，限域迭代、对比成败 | 限定每轮至多修改 6 个预定义模块之一（`loop`, `tools`, `observation`, `context`, `completion`, `product`）。 |
| **RRSI** ([arXiv:2609.24972](https://arxiv.org/abs/2609.24972)) | 正则化提案预算、剪枝单样例过拟合修改 | 引入文件数/行数超预算惩罚、2×费用纪律否决与可复用性审查。 |
| **AlphaEvolve** ([arXiv:2506.13131](https://arxiv.org/html/2506.13131v1)) | EVOLVE-BLOCK 冻结评估区、低成本优先早停验证级联 | 冻结 `GOAL_VECTOR.md` 哈希与路径防护，实施首败即停外部验证级联。 |
| **GEPA** ([arXiv:2507.19457](https://arxiv.org/html/2507.19457v2)) | 轨迹反思、Pareto 非支配保留、校准评审 | 实现四态归档裁决、非支配前沿裁剪与多评委截尾均值校准。 |
| **Dream-RSI** ([arXiv:2609.14858](https://arxiv.org/abs/2609.14858)) | 以发现树作为世界模型离线回放并单调改进探索策略 | 引入依赖感知批次轮数与安全过滤的离线回放，严格隔离回放分与产品验收。 |
| **SEAL / MedRSI** ([SEAL](https://arxiv.org/abs/2506.10943)) | 试错自编辑与防灾难性遗忘保留检查；快发现慢注册 | 实现 `retentionPassed` 防遗忘硬门控与 `slowRegisterGate` 慢注册机制。 |
| **Trusting Trust Revisited** ([arXiv:2609.17817](https://arxiv.org/abs/2609.17817)) | 揭示受污染基准诱导安全退化且污染持久残留 | 嵌入不可谈判不变量、纪律一票否决与反思库污染正则拦截器。 |
| **Agentless / SWE-Search / Self-Repair / CodeMonkeys / The RSI Tax / Beneath the Surface** ([Agentless](https://arxiv.org/abs/2407.01489), [SWE-Search](https://arxiv.org/abs/2410.20285), [Self-Repair](https://arxiv.org/abs/2306.09896), [CodeMonkeys](https://arxiv.org/abs/2501.14723), [The RSI Tax](https://arxiv.org/abs/2611.13524), [Beneath the Surface](https://arxiv.org/abs/2611.07624)) | 分阶段定位修复验证、自修复成本收益边界、覆盖率权衡与成本归一化评测 | 默认单路径验证、同诊断连续修复熔断、独立保存现役实测向量，不盲目放大每轮模型调用。 |

此外，一项按固定检索式审阅 114 篇研究的系统综述（[arXiv:2610.27610](https://arxiv.org/html/2610.27610v1)）指出，在 26 篇宣称改进流程本身更强的研究中，仅 4 篇在相同初始产物与相同预算下完成了受控对比。这一实证结论直接塑造了本文系统的停机语义：任何有限预算下的停止均仅报告为**预算内局部收敛**，绝不宣称全局最优。

---

## 3. 形式化问题定义与安全不变量

设桌面工作区状态空间为 $\mathcal{W}$，用户任务章程与冻结目标向量定义为四元组：
$$\mathcal{G} = \langle C, \mathcal{M}, t_0, \mathcal{N} \rangle$$
其中 $C$ 为章程目标，$\mathcal{N}$ 为非目标与范围限制，$\mathcal{M} = \{m_1, \dots, m_k\}$（$2 \le k \le 5$）为冻结外部指标集。每个指标 $m_i = \langle \text{id}_i, \text{cmd}_i, d_i \in \{\uparrow, \downarrow\}, b_i, s_i, \underline{\delta}_i \rangle$ 规定稳定标识、外部可执行命令、优化方向、首次 ASSESS 冻结的有限数值基线 $b_i \in \mathbb{R}$、尺度归一化系数 $s_i > 0$ 与允许回归下界 $\underline{\delta}_i$。

定义冻结评估区路径集合 $\mathcal{F} \subset \mathcal{W}$（包含 `.conecode/rsi/GOAL_VECTOR.md` 及各独立会话归档下的目标文件），以及单个候选提案：
$$c = \langle \text{id}, \mu \in \mathcal{U}, h, \mathcal{S}, (T, D), (F_{\max}, L_{\max}), B_{\$} \rangle$$
其中 $\mathcal{U} = \{\text{loop}, \text{tools}, \text{observation}, \text{context}, \text{completion}, \text{product}\}$ 为 6 个互斥模块，$\mathcal{S}$ 为成功标准集，$(T, D)$ 分别为声明修改集（`touch`）与保护集（`doNotTouch`），$(F_{\max}, L_{\max})$ 为编辑预算，$B_{\$}$ 为单轮费用预算。

系统在程序层强制维持四条形式化安全不变量：
- **I1（目标冻结不变性）**：设初始指纹 $h_0 = H(\text{GOAL\_VECTOR.md})$，每轮候选执行前必须满足 $H(\text{GOAL\_VECTOR.md}) = h_0$，否则中止并回滚。
- **I2（工作区与 EVOLVE-BLOCK 封闭性）**：$\forall p \in T$，路径规范化后必须满足 $\text{norm}(p) \subseteq \mathcal{W}$ 且 $\text{norm}(p) \cap (\mathcal{F} \cup D) = \emptyset$。
- **I3（外部可验证性）**：$\forall s \in \mathcal{S},\, s.\text{external} = \text{true}$；外部验证级联非空，且全部必需冻结指标均须产出有限实测值。
- **I4（安全不退化与防污染）**：纪律评分为零（或任一评委否决）立即拒绝候选；任何包含绕过、禁用校验或删除测试语义的教训均禁止写入持久化反思记忆。

---

## 4. 系统架构与核心方法

### 4.1 职责解耦与会话隔离持久化架构

为保证核心决策逻辑的可验证性与跨进程可移植性，系统将全部算法实现为无副作用或依赖注入（`RsiFs`）的纯 TypeScript 模块，独立于 Electron 主进程与 React UI。每个 RSI 会话拥有独立的持久化目录 `.conecode/rsi/conversations/<safeId>/`，内含冻结目标 `GOAL_VECTOR.md`、冻结基线 `BASELINE.json`、版本化循环检查点 `LOOP_STATE.json`、仅追加发现树 `trees/<episode>.json`、写一次迭代报告 `iterations/<id>.md`、慢注册演进日志 `EVOLUTION_LOG.md`、污染过滤反思库 `REFLECTIONS.md` 与当前探索策略 `STRATEGY.md`。

### 4.2 外部锚定复合奖励与抗偏置多评委校准

设候选 $c$ 经外部验证级联运行后获得结果 $e = \langle p_{\text{ext}}, \{\Delta_i\}_{i=1}^k, \mathbf{j}, F, L \rangle$，其中有符号增量为 $\Delta_i = v_i - b_i$（$d_i = \uparrow$）或 $\Delta_i = b_i - v_i$（$d_i = \downarrow$）。引入独立尺度归一化 $\tilde{\Delta}_i = \Delta_i / \max(s_i, 10^{-9})$ 与归一化权重 $\tilde{w}_i = w_i / \max_j w_j$，定义复合标量奖励：
$$R(e) = \begin{cases}
-999, & \text{if } \neg p_{\text{ext}} \lor \neg\text{valid}(\mathbf{m}) \lor \exists i\,(\tilde{\Delta}_i < \underline{\delta}_i) \lor F < 0 \lor L < 0 \\
1.2 \cdot \bar{M}(e) + 0.8 \cdot \bar{J}(\mathbf{j}) - P_{\text{cost}}(F, L), & \text{otherwise}
\end{cases}$$
其中：
$$\bar{M}(e) = \frac{\sum_{i=1}^{k} \tilde{w}_i \tanh(\tilde{\Delta}_i)}{\sum_{i=1}^{k} \tilde{w}_i}, \quad \bar{J}(\mathbf{j}) = \frac{1}{3}\sum_{u \in \{a,s,d\}} \text{clip}_{[0,1]}(j_u)$$
$$P_{\text{cost}}(F, L) = 0.25\left(\frac{\max(0, F-6)}{6} + \frac{\max(0, L-400)}{400}\right)$$

$\tanh(\tilde{\Delta}_i)$ 将各维度平滑压缩至 $(-1, 1)$，避免单一极端量纲主导总分；硬下界 $\underline{\delta}_i$ 确保无回归守卫指标（如错误数、失败测试数）无法被其他维度的提速所“赎买”。

**多评委校准**：当引入 $P$ 个只读评审面板 $\{\mathbf{j}^{(1)}, \dots, \mathbf{j}^{(P)}\}$ 时，若存在任一面板满足 $\text{clip}_{[0,1]}(j_d^{(p)}) \le 0$，则直接触发全局纪律否决（$j_d = 0$）；对其余维度在 $P \ge 3$ 时取截尾均值（剔除最大值与最小值各一个后求平均），有效抑制单评委极端漂移。

**防“评委讨好”晋升条件**：设现役最优的归一化实测向量为 $\tilde{\boldsymbol{\Delta}}^{\star}$（首轮取 $\mathbf{0}$）。候选替换现役必须同时满足：
1. 通过全部硬门控与纪律检查，且指标键集与 $\tilde{\boldsymbol{\Delta}}^{\star}$ 完全一致；
2. **实测增益条件**：$\exists i \in \{1,\dots,k\},\, \tilde{\Delta}_i > \tilde{\Delta}^{\star}_i + \epsilon$（默认 $\epsilon = 10^{-3}$）；
3. **综合奖励严格改进**：$R(e) > R^{\star} + \epsilon$。

该双重条件从形式上保证了：即使新评审面板给出更高主观打分，只要外部指标未相对现役产生实质性正向突破，候选仍会被严格拒绝。

### 4.3 Pareto 非支配前沿保留与现役实测解耦

定义候选 $a$ 支配候选 $b$（记为 $a \succ b$）当且仅当二者指标键集相同、分量均有限、$\forall i,\, \tilde{\Delta}_i^{(a)} \ge \tilde{\Delta}_i^{(b)}$ 且 $\exists j,\, \tilde{\Delta}_j^{(a)} > \tilde{\Delta}_j^{(b)}$。四态归档裁决函数 `selectForArchive` 将每个候选映射至三种动作之一：
- **`replace-best`**：满足 4.2 节晋升条件，替换现役并加入前沿；
- **`retain-frontier`**：未超越现役总分，但无硬违规、相对固定基线至少在一维存在 $>\epsilon$ 增益、与现有前沿 $\mathcal{A}$ 中所有节点均非 $\epsilon$-等价，且不被 $\mathcal{A}$ 中任何节点支配；将其保留于前沿并裁剪新被支配节点（`pruneArchive`），同时工作区回滚至现役状态；
- **`reject`**：重复 ID、硬违规、无正向增益、与前沿等价或被前沿支配。

为解决“高编辑成本但全维度支配现役的候选进入前沿并将现役从 $\mathcal{A}$ 中裁剪，导致下轮失去现役实测对照”的结构性问题，系统将 `state.best.metrics` 独立持久化于检查点中，并在加载历史检查点时支持从发现树自动回溯恢复现役实测向量。

### 4.4 程序化单回合闭环与正向存在性快照回滚

单回合闭环由确定性状态转移函数编排（算法 1），同步编排器（`rsiEpisode.ts`）与异步 IPC 桥接裁决器（`rsiBridge.ts`）保持完全一致的门控顺序：

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
5. Execute mutation within sandbox; compute undeclared creations via parent-dir diff
6. cascade ← runVerifyCascade(stages)                  // cheapest-first, early-exit
7. (deltas, missing) ← buildMetricDeltas(bindings, baseline, cascade.stages)
8. effectivePass ← cascade.passedAll ∧ (missingRequired = ∅) ∧ (retentionPassed ≠ false)
9. if costUsd > 2 · c.costBudgetUsd ∧ effectivePass then judges.discipline ← 0
10. outcome ← recordEpisodeOutcome(S, c, effectivePass, deltas, costUsd)
11. if outcome.mustRollback then rb ← rollbackWorkspace(snap, undeclaredCreations)
12. Persist tree node (idempotent) & iteration markdown (write-once)
13. if outcome.verdict = replace-best ∧ slowRegisterGate(outcome.state) then
        appendEvolutionLog(...)
14. stop ← evaluateStop(outcome.state, cfg); if stop.shouldStop then markStopped()
15. Persist LOOP_STATE.json and return (S', outcome.verdict, rb)
```

在异步桌面文件桥接中，为防止底层 IPC 吞错导致回滚误删已有文件，`snapshotWorkspace` 实施**正向存在性证明**：仅当 `pathExists(p)` 明确返回 `false` 时才允许将路径记入 `absentPaths`；读取失败或目录列表为空时拒绝创建快照并中止。在验证输出解析环节，`parseVitestSummary` 与 `parseTscOutput` 先经 `stripAnsi` 剥离终端颜色转义码，保证彩色输出下指标提取与无 ANSI 输出完全一致。

### 4.5 依赖感知的 DREAM 发现树离线回放与单调策略选择

在线验证成本高昂，因此系统在积累足够发现树历史 $\mathcal{H} = \{\tau_1, \dots, \tau_m\}$ 后，引入纯离线的 DREAM 策略评估阶段（`rsiReplay.ts`）。探索策略定义为 $\pi = (N_{\max}, \text{spread}, W)$，其中 $N_{\max}$ 为单树最大揭示尝试数，$W \ge 1$ 为声明并行度。

为避免策略仅通过虚报高并行度 $W$ 在串行父子依赖历史上骗取并行奖励，系统设计了**依赖感知批次轮数计算**（算法 2）：

```text
Algorithm 2: Dependency-Aware Replay Rounds & Scoring
Input:  DiscoveryTree τ, ExplorationPolicy π = (N_max, spread, W), β1=0.05, β2=0.02
Output: ReplayScore (maxReward, N, rounds, V)

1. revealed ← τ.nodes[0 .. min(N_max, |τ.nodes|) - 1]; N ← |revealed|
2. pending ← copy(revealed); completed ← ∅; rounds ← 0
3. while pending ≠ ∅ do
       ready ← first W nodes v ∈ pending such that (v.parentId = null ∨ v.parentId ∈ completed)
       if ready = ∅ then rounds ← N; break          // malformed lineage: no batching bonus
       completed ← completed ∪ {v.id | v ∈ ready}
       pending ← pending \ ready; rounds ← rounds + 1
4. rounds ← max(1, rounds)
5. valid ← {v ∈ revealed | v.externalPass ∧ v.status ≠ "failed" ∧ baseReason(v) ∉ INVALID_REASONS}
6. maxReward ← max({v.reward | v ∈ valid} ∪ {-999})
7. V ← (N = 0 ? -999 : maxReward) - β1 · N + β2 · (N / rounds)
```

其中 `baseReason(v)` 剥离 `+rollback-errors` 等复合后缀，确保被纪律否决、硬下界违背或超预算的节点绝不进入有效奖励集合。策略选择函数 `selectExplorationPolicy` 具备两条形式化保障：
- **薄历史防过拟合**：当 $|\mathcal{H}| < 2$ 或总实验节点数 $\sum |\tau_i| < 4$ 时，强制保留现役策略并标记 `evidenceSufficient = false`；
- **单调不退化性**：由于现役策略始终位于评估集合中且平局由现役胜出，仅当候选策略平均回放分 $\bar{V}(\pi') > \bar{V}(\pi_{\text{inc}}) + 10^{-6}$ 时才部署新策略，保证探索策略在固定历史森林上单调不退化。

### 4.6 运行时证据监视器与多模态视觉接受闭环

在实时代理对话循环（`chat.store.ts`）中，`RsiExecutionMonitor`（`rsiRuntime.ts`）持续观测全部工具调用事件，提供四重运行时约束：
1. **安全 Shell 子集与目录感知匹配**：拒绝管道、重定向与子 Shell 等可能隐藏失败退出码的语法，将每个检查规范化为 `(effectiveCwd, command)` 序列，防止异目录命令冒充目标验证；
2. **产品修订号失效**：任何非 `.conecode/rsi/**` 路径的写操作或未知 `exec` 均递增 `revision`，清空旧修订的冻结检查通过集合与视觉核验状态；归档簿记不触发失效；
3. **重复失败与同诊断熔断**：同一工具无代码改动连败 3 次，或同一检查在不同代码编辑后连续 3 次返回相同完整诊断，强制停机；第 2 次即注入假设切换提示；
4. **多模态视觉核验闭环**：全部冻结检查在当前修订通过后，若尚未完成视觉复核，运行时自动拦截提前结束声明并触发官方 `auto_screenshot` 插件截屏（校验前台会话与工作区归属、捕获目标一致性及视觉模型能力），为图像分配递增 `ticket`；仅当模型在下一轮真实接收像素并完成复核后，才放行完成态。

### 4.7 慢注册、防污染反思记忆与预算有限局部收敛

- **慢注册（`slowRegisterGate`）**：仅当累计独立接受次数 $\ge 2$ 或获用户显式批准且接受次数 $\ge 1$ 时，才允许写入长期演进日志 `EVOLUTION_LOG.md`；
- **防污染反思库（`REFLECTIONS.md`）**：正则拦截一切削弱安全/跳过测试类教训，合法规则按单调递增序号分配唯一 ID，重复规则通过追加 `episodeId` 强化，滑窗上限控制在 30 条，并在注入模型上下文时经由 `<rsi-history-data>` 不可信数据标签与字符转义隔离；
- **崩溃自愈（`recoverLoopState`）**：检查点损坏或缺失时自动回退至发现树按时间顺序幂等重建状态；
- **停机准则（`evaluateStop`）**：综合用户中断、目标不可验证、连续 2 次硬失败、回合预算耗尽、成本锁（`2×`）与硬花费上限（`4×`）、同类失败 3 连击以及至少 1 次接受后的 3 轮无改进局部平台期（并结合最近 4 轮模块集中度 $\ge 75\%$ 识别窄搜索 `local-plateau-narrow-search`）。

---

## 5. 实现细节与实证评估

### 5.1 自动化契约验证矩阵

系统全部逻辑在 TypeScript 中实现并通过 `tsc -p tsconfig.check.json` 静态类型检查（RSI 模块零错误）。我们在 Node v24.19.0 / Vitest 4.1.11 环境下运行了全部 **21 个 RSI 自动化测试套件（共 259 个测试用例）**，全部通过（总耗时 `1.16s`），契约覆盖分布如表 2 所示：

| 验证维度 | 覆盖模块 | 测试文件数 | 用例数 | 验证内容 |
| --- | --- | ---: | ---: | --- |
| 奖励、硬门控与 Pareto 前沿 | `rsiReward.ts` | 2 | 35 | 外部硬门控、尺度归一化、硬下界、防评委讨好、多评委截尾均值、支配关系与裁剪、`NaN` 容错 |
| 状态机、编排与异步桥接 | `rsiLoop.ts`, `rsiEpisode.ts`, `rsiBridge.ts` | 4 | 50 | 候选路径封闭与 EVOLVE-BLOCK 防护、正向存在性快照与未声明文件回滚、停机边界、防遗忘与预算门控 |
| 外部验证与运行时监视器 | `rsiVerify.ts`, `rsiRuntime.ts`, `rsiHistory.ts` | 3 | 55 | 早停级联、ANSI 清洗与输出解析、双语目标表解析、修订号失效、同诊断熔断、截图票据闭环与防注入转义 |
| 发现树、持久化与 DREAM | `rsiTree.ts`, `rsiPersistence.ts`, `rsiReplay.ts`, `electron/rsi/store.ts` | 4 | 27 | 幂等追加与严格反序列化、崩溃树重建、慢注册与污染教训拦截、滑窗单调 ID、依赖感知离线回放与单调选择 |
| 宿主循环与桌面 UI 集成 | `chat.store.ts`, `rsiConversation.ts`, `rsiStart.ts`, `components/rsi/*` | 8 | 92 | 执行授权与讨论隔离、成本锁熔断、自动截屏复核、会话独立归档、macOS 权限门控与工作台布局隔离 |
| **合计** | **全链路 RSI 子系统** | **21** | **259** | **100% 通过（1.16s）** |

### 5.2 运行时证据闭环固定轨迹对照实验

为评估程序化运行时监视器对“未充分验证即提前收尾”问题的拦截能力，项目采用真实仓库的冻结目标契约（2026-11-08 安装器修复目标，包含两文件定向测试、类型检查、全量测试与 `perf_snapshot` 共 4 项冻结检查），将同一组 9 条模拟工具事件轨迹分别输入旧版与新版监视器并在末尾请求一次收尾（结果引自项目实证记录 `docs/compose/spec/rsi-research-notes.md`）：

| 轨迹类型 | 轨迹数 | 旧版判对 | 新版判对 | 判定分析 |
| --- | ---: | ---: | ---: | --- |
| 完整达标（4 项齐全、齐全后仅写归档、改动后重新跑齐） | 3 | 3 (100%) | 3 (100%) | 两版均正确识别并放行 |
| 证据不足（仅跑类型检查、漏性能快照、异目录跑全量测试、定向测试漏文件、改动后仅重跑类型检查） | 5 | 0 (0%) | **5 (100%)** | 旧版全部误标完成；新版精确指出缺失检查与修订失效并要求补验 |
| 明确失败（全量测试失败） | 1 | 1 (100%) | 1 (100%) | 两版均正确拦截 |

实验表明，在固定真实契约上，新版运行时监视器将证据不足轨迹的漏检率由 100% 降至 0%，同时在完整达标轨迹上保持 0% 误拦。

### 5.3 核心机制性质分析

1. **早停验证级联的经济性**：将低开销的编译/类型检查置于全量测试与构建之前，任意前序失败即刻终止并记录 `costSteps`，在单次失败回合中避免执行高昂的后序阶段。
2. **依赖感知回放的抗虚增性质**：对于包含串行父子链 $v_1 \to v_2 \to \dots \to v_N$ 的发现树，无论策略声明多大的并行度 $W$，算法 2 均计算出 $\text{rounds} = N$，从而使并行奖励项恒等于 $\beta_2$，从数学上杜绝靠虚报并行度误导策略选择。
3. **无静默丢失的崩溃恢复一致性**：由于每轮无论接受、拒绝还是回滚均向发现树追加不可变节点并记录基础失败类别与归一化实测向量，即使 `LOOP_STATE.json` 在崩溃中损坏，`rebuildLoopStateFromTrees` 仍能无损还原与在线循环等价的现役最优、Pareto 前沿及连败计数。

---

## 6. 讨论与局限性

本架构在工程落地中仍存在以下明确边界与未来研究方向：
1. **端到端跨仓库基准评测**：当前实证主要验证了模块契约不变量与固定轨迹拦截准确率；真实多仓库场景下的任务解决率、单位成功任务 Token/美元成本以及 DREAM 长期策略演化的统计增益，仍有待在固定快照、同模型同预算条件下开展大规模端到端对照实验。
2. **非文件型副作用的事务隔离**：当前快照机制可可靠覆盖声明路径与父目录新建文件，但对命令执行引发的深层子目录变更、外部服务状态或环境变量副作用尚不具备完全事务回滚能力，结合 Git Worktree 或写时复制（Copy-on-Write）文件系统是自然的工程延伸。
3. **宿主性能采样与目标应用观测分离**：内置 `perf_snapshot` 采集的是桌面宿主进程内存与负载，对独立运行的目标服务性能评估仍需依赖冻结目标中声明的项目专属基准脚本。
4. **元级自我改进的人类门控权衡**：将协议与安全不变量的自修改设为严格用户门控虽限制了全自动元演化上限，但对于桌面生产工具而言，这是防止安全退化与目标漂移的必要底线。

---

## 7. 结论

本文系统形式化并分析了 ConeCode 的有界锚定式递归自我改进（RSI+RL）架构。通过将外部目标冻结、尺度归一化复合奖励与抗偏置评审、现役解耦的 Pareto 前沿保留、正向存在性快照回滚、依赖感知的 DREAM 发现树离线回放以及修订号驱动的运行时视觉闭环固化为确定性程序门控，系统在真实桌面编程环境中有效化解了目标漂移、基准过拟合、安全污染与验证空转四大难题，为构建可审计、预算受控、安全可靠的自主演进软件工程智能体提供了完整的参考蓝图。

---

## 参考文献

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
