---
feature: agent-modes-rsi
status: designed
updated: 2026-09-17
branch: feat/agent-modes-rsi
commits: <base-sha>..<head-sha>
---

# Agent Modes: Goal / Orchestrate / RSI

## Report

## [S1] Problem

产品缺少与「小米式」目标驱动、多智能体编排对等的一等模式；更关键的是没有严谨的 **递归自我改进（RSI）** 协议——不能只是「自己觉得更好就改」，必须锚定外部指标、限制可改进面、防止安全被「跑分」腐蚀。

## [S2] Design

### Research grounding

见 `docs/compose/spec/rsi-research-notes.md`（GAI 锚定评估、DGM 档案、ModularRSI 模块化、RRSI 正则化、Trusting Trust 投毒、MedRSI 慢注册）。

### Modes

| Mode | 行为 |
|------|------|
| `standard` | 现有编码循环 |
| `goal` | 长期目标推进，直到**外部**完成条件验证通过 |
| `orchestrate` | 主控拆解 + 子智能体调研 + 主控集成与验证 |
| `rsi` | 有界、锚定的递归自我改进（见下） |

Plan / Review 为只读叠加层，激活时抑制执行类 `agentMode` 提示。

### RSI+RL contract (summary)

- **True RSI + Anchored oracle**：改进步骤由本 run 自选自执行；成败硬门槛只认外部命令/用户章程（禁止纯自我评价）。
- **Goal vector**：先冻结 2–5 个可测指标（`GOAL_VECTOR.md`），搜索中不得静默改指标。
- **RL 回合**：SAMPLE → DECLARE → EXECUTE → VERIFY（硬门槛）→ **SCORE & SELECT** → 接受则慢注册 / 拒绝则回滚归档。
- **编排打分**：2–4 只读评审子智能体（alignment / simplicity / discipline）；**discipline 可一票否决**；评审不能把失败候选买成成功。
- **奖励**：外部指标主导 + 评审均值 − 成本惩罚（`rsiReward.ts` 可单测）。
- **收敛**：连续 3 个候选无法超过 best 即 **局部最优停止**（这就是「到最优」）。
- **可改进面**：workspace 内 product / verification / project harness / docs。不可改：不变量、goal vector 含义、审批/沙箱、安全控件；协议自改进仅可提案（user-gated）。
- **模块化**：每轮至多一个模块（loop/tools/observation/context/completion/product）。
- **档案**：`.conecode/rsi/iterations/<id>.md` + `EVOLUTION_LOG.md`，不重写历史。

### UI / commands

- ChatInput 模式菜单（Standard / Goal / Orchestrate / RSI）+ `/mode <name>`。
- 共享 `RSI_INVARIANTS` 嵌入全部非 standard 模式；`modePrompts.test.ts` 钉死安全句与相位。

### Testing boundary

- 纯提示词契约测试（20）；不测 React 菜单点击。

## [S3] Out of Scope

- 模型权重训练、跨 workspace 进化、自动 commit/push。
- 协议不变量的自动改写。
- 编排模式的运行时多进程调度器（以现有 sub-agent / headless 为限）。

## Tasks

- [x] T1: modePrompts + RSI 单测 — acceptance: 20 tests pin invariants/phases (covers: S2)
- [x] T2: chat.store agentMode + UI + /mode — acceptance: 注入 overlay，Plan 抑制执行模式 (covers: S2; depends: T1)
- [x] T3: en/zh/ja 文案 + typecheck/test/build — acceptance: 无 raw key，套件通过（devserver reload 用例为已知 flaky） (covers: S2)
