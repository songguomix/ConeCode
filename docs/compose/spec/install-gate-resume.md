---
feature: install-gate-resume
status: delivered
updated: 2026-09-26
branch: feat/install-gate-resume
commits: 2303ea9..a7de80b
---

# Install Gate — pause model output during any install, auto-continue after

## Report

**What was built** — 统一 `installGate`：`download` 工具、ngrok 安装、模型列表拉取、技能安装/保存都计入安装中；安装期间暂停模型生成（停当前 run）、禁用发送/edit/resend，UI 显示「安装中」条。全部安装结束后，自动切回被暂停的会话、注入续跑提示并 `runAgentLoop` 继续工作（后台会话按 id 重载 transcript）。

**Verification** — `typecheck` PASS；`installGate.test.ts` PASS (5)；`npm test` PASS (649)。独立 review 多轮 REQUEST_CHANGES 后已修：续跑目标会话、release 贯穿、edit/resend 门控、`autoCompact` 不得压缩错误线程、await 后实时校验 active。

**Journey log** — `sendMessage` 只作用 active 会话，后台续跑必须 `runAgentLoop(convId)`。`autoCompactIfNeeded` 读可见 messages，非 active 时不能调用。`getState()` 跨 await 会过期，append/compact 前必须重读。`end()` 必须配对 release，否则 resumePending 粘住。下载任务 id 要含时间戳防同 URL 并发冲突。

## [S1] Problem

安装/下载（工具二进制、依赖、模型列表、技能、agent 的 `download` 等）进行时，模型可能仍在生成或立刻被再次唤醒，界面无「安装中 / 已暂停」状态；装完后也不会自动接着干活。需要像 Claude：**安装时停模型输出，装好自动激活并继续**。

## [S2] Design

### InstallGate store（统一门控）

`src/stores/installGate.store.ts`：jobs / heldConversationId / resumePending；`begin`/`end`/`markResume`/`release`（返回待续跑会话 id，一次性）。

### 接入的安装源

| 源 | 行为 |
|----|------|
| agent `download` | begin/end，任务 id 含时间戳 |
| `installNgrok` | begin + holdModelForInstall |
| `fetchModels` / `fetchAllModels` | begin/end + release |
| 技能 install / saveCustom | begin/end + release |
| 发送 / edit / resend | isHolding 时拒绝 |

### 续跑

`maybeResumeAfterInstall`：release → setActive(held) → 写入续跑消息 → 实时确认仍 active 才 compact → `runAgentLoop(convId)`（非 active 时按 id 重载）。

### UI

ChatView 安装中横幅；安装期间发送键禁用。

## [S3] Out of Scope

- 下载管理器 / 断点续传。
- 改 provider 流协议。
- 自动安装用户未点过的组件。

## Tasks

- [x] T1: installGate store + 单测 — acceptance: begin/end/hold/release/resumePending 有测 (covers: S2)
- [x] T2: 接入 download / ngrok / fetchModels / skills — acceptance: 各源 begin/end 与 release (covers: S2; depends: T1)
- [x] T3: UI 暂停条 + 装完自动继续 — acceptance: holding 时禁发；release 后目标会话 runAgentLoop (covers: S2; depends: T1)
