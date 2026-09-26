---
feature: install-gate-resume
status: designed
updated: 2026-09-26
branch: feat/install-gate-resume
commits: 
---

# Install Gate — pause model output during any install, auto-continue after

## Report

## [S1] Problem

安装/下载（工具二进制、依赖、模型列表、技能、agent 的 `download` 等）进行时，模型可能仍在生成或立刻被再次唤醒，界面无「安装中 / 已暂停」状态；装完后也不会自动接着干活。需要像 Claude：**安装时停模型输出，装好自动激活并继续**。

## [S2] Design

### InstallGate store（统一门控）

`src/stores/installGate.store.ts`：

```ts
interface InstallJob {
  id: string;
  label: string;          // 展示名
  kind: 'download' | 'tool' | 'model' | 'skill' | 'dep';
  startedAt: number;
}
// state: jobs: Record<id, InstallJob>
//        heldConversationId: string | null   // 安装打断时的会话
//        resumePending: boolean              // 装完是否自动继续
```

API：
- `begin(id, label, kind)` / `end(id)`（幂等）
- `holdModel(conversationId)` — 若该会话正在生成则 `stopGeneration` 并记 `resumePending`
- `releaseModel()` — 清空 hold；若 `resumePending` 且仍空闲，则自动向该会话发一句续跑提示（模型激活）并清标记

派生：`isHolding`（jobs 非空）、`activeLabel`。

### 接入的安装源（全部）

| 源 | 行为 |
|----|------|
| agent `download` 工具 | `begin/end`；工具阻塞循环期间 UI 显示安装中 |
| `installNgrok` / `installCloudflared` | `begin/end` + `holdModel` |
| `fetchModels`（模型列表拉取） | `begin/end` kind=model |
| 技能安装 deploy | `begin/end` kind=skill |
| 用户在安装中发送 | 入队或直接 hold：有 hold 时不启动新 run，直到 release |

### UI

- ChatInput/ChatView 顶部窄条：`安装中 · <label> — 模型已暂停`；结束后短暂 `安装完成，继续工作中…`
- 安装中禁用发送（或显示排队），release 后自动 `sendMessage("Install finished. Continue the work.")`（仅当 resumePending）。

### 测试边界

- store 纯逻辑：begin/end、hold 多 job、resumePending 只触发一次、end 幂等。
- 不测真网络下载。

## [S3] Out of Scope

- 不做并行下载管理器 / 断点续传。
- 不改 provider 流式协议。
- 不自动安装用户未点过的组件。

## Tasks

- [ ] T1: installGate store + 单测 — acceptance: begin/end/hold/release/resumePending 行为有测 (covers: S2)
- [ ] T2: 接入 download / installNgrok / installCloudflared / fetchModels / skill deploy — acceptance: 各源 begin/end 与 holdModel 调用齐全 (covers: S2; depends: T1)
- [ ] T3: UI 安装中暂停条 + 装完自动继续 — acceptance: 有 hold 时不新跑模型；release 后 resumePending 会发续跑消息 (covers: S2; depends: T1)
