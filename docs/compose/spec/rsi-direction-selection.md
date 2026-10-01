# RSI 方向选型（ConeCode）— 2026-09

结论先行：**最适合的是「锚定的 Harness/产品进化」——以发现树 + Dream 离线选型降低成本，以慢注册与硬门槛保安全。**
不做 DGM 式无限自我改写，也不做权重 RL。

## 路线全景

| 方向 | 代表 | 机制 | 对 ConeCode 适配 | 风险 |
|------|------|------|------------------|------|
| A. 自改代码 / 无限自我复制 | DGM, Hyperagents, Live-SWE-agent | 改自己的 scaffold/代码，基准驱动，档案树 | 中：可做 workspace 内 harness，不能碰宿主 | 高（Trusting Trust 投毒、goal drift） |
| B. **Harness 模块化进化** | ModularRSI, RRSI, SoL-Pi | 拆 loop/tools/observation/context/completion，限域改，正则化 | **高**：与 ConeCode skills/AGENTS/工具同构 | 中（需硬门槛） |
| C. **探索策略 + 回放仿真** | Dream-RSI | 发现树当 world model，离线 dream 改探索策略 | **高**：已有 rsiReplay / Phase H | 低 |
| D. 领域能力注册 | MedRSI | 失败→新能力，慢注册进持久 agent | **高**：EVOLUTION_LOG / skills | 低 |
| E. 环境进化 | Env-Rethink | 改环境状态/噪声造更难任务 | 低：产品不是训练场 | 中 |
| F. 模型权重 RL | 各类 RLHF/RLVR | 训练基座 | **无**：桌面端无训练环 | — |
| G. 元改进改进器 | Last AI 路线图顶层 | 改「如何改进」 | 仅提案、用户门控 | 很高 |

## 为什么是 B + C + D（合成）

1. **GAI 锚定**：成功只认外部命令/用户章程 —— 桌面产品必须可审计，禁止自评裁决。
2. **ModularRSI**：进化面收窄到 5+1 模块，一轮一处，可归因、可回滚。
3. **Dream-RSI**：在线 VERIFY 贵；用发现树离线试「下一刀切哪、预算多大、要不要并行」，单调选探索策略。
4. **MedRSI**：发现可以快，写入 skills/AGENTS/EVOLUTION_LOG 要慢（防污染残留）。
5. **RRSI**：editBudget 退火 + 剪枝，拒绝「只绿一个 fixture」。

## 明确不做

- 全量 DGM：允许改写安全轨 / 宿主 → 禁止。
- 权重训练 / 微调：产品外。
- 环境投毒式自我对战：与「Trusting Trust」攻击面重叠。
- 无锚定 LLM 打分当唯一胜利条件。

## 推荐落地顺序（产品）

1. **P0 已有**：RSI+RL 硬门槛 + 编排评委 + rsiReward / rsiReplay / Phase H。
2. **P1 发现树文件契约**：`.conecode/rsi/trees/*.json` 真正落盘，dream 用真实历史。
3. **P2 探索策略持久化**：`exploration-policy.json`（maxAttempts / moduleSpread），按 dream 单调更新。
4. **P3 能力注册**：连续 PASS 的 harness 改动 → 项目 skill / AGENTS 片段（慢注册）。
5. **P4 可观测**：EVOLUTION_LOG 看板（reward 曲线、模块分布、拒绝原因）。

## 一句话

> **选「有界的 Harness/产品 RSI」：外部指标锚定 + 模块化小步 + Dream 离线改进探索 + 慢注册。**
> 这是在桌面 AI 编程产品上，效果、成本、安全三者唯一能同时站住的方向。
