---
feature: sidebar-project-groups
status: delivered
updated: 2026-09-17
branch: feat/sidebar-project-groups
commits: 2303ea9..16bdd3e
---

# Sidebar Project Groups (Codex-style)

## Report

**What was built** — 侧边栏对话列表改为 Codex 风格的项目分组：每个母文件夹（`Conversation.rootPath`）作为分组头在上，该文件夹下的对话缩进列在下面；无文件夹的对话归入「无项目」组并排在有文件夹的组之后。分组/排序由纯函数 `groupConversationsByRoot` 完成，同名文件夹用 `rootLabel` 消歧。底部文件树收成可折叠的「文件」区，展开状态写入 `conecode.fileTreeOpen` 并跨重启记忆；无工作区时仍强制显示「打开文件夹」，避免折叠把入口锁死。对话行的运行态、改动文件名、重命名/删除交互保持不变。

**Verification** — `npx vitest run src/components/layout/conversationGroups.test.ts` PASS (8)；`npm run typecheck` PASS；`npm test` PASS (652 tests / 42 files)；`npm run build` PASS。独立 review（2303ea9..16bdd3e）APPROVE，T1–T4 全部满足，无 critical。

**Journey log** — 布局方案在 Grill 阶段定为「按项目分组 + 文件树可折叠」，未走简单上下对调。分组契约做成纯函数并先测后接 UI，避免把排序逻辑埋进 React。`normalizeRoot('/')` 会变成 `''`（归入无项目）是既有 helper 行为，本次未改。折叠组中途重命名会卸载输入框但保留 `editingId`，属非关键边角。

## [S1] Problem

侧边栏把所有对话平铺在一起，再在底部挂一棵文件树。多项目来回切换时，看不出哪条对话属于哪个母文件夹，找历史对话要靠扫标题。目标是像 Codex：母文件夹在上作为分组头，该文件夹下的对话列在下面。

## [S2] Design

### Layout

侧边栏中部滚动区自上而下：

1. **项目分组列表** — 每个分组 = 一个母文件夹（`Conversation.rootPath`），或「无项目」（`rootPath` 为空）。
2. **可折叠文件树** — 现有 `FileTree` 收到底部独立区块，带折叠/展开开关。

### Grouping contract

纯函数 `groupConversationsByRoot(conversations, labels?)`（`src/components/layout/conversationGroups.ts`）：

- 入参：`Conversation` 的 `id` / `title` / `rootPath` / `updatedAt` 子集；可选 `labels: Map<path, label>` 提供去重后的显示名。
- 分组键：`normalizeRoot(rootPath)`；空/null → `''`（无项目）。
- 组内对话按 `updatedAt` 降序（新→旧）。
- 组间按组内最新 `updatedAt` 降序。
- 每组输出：`key`、`rootPath`、`label`（文件夹名，冲突时用 `rootLabel`；无项目组由 UI 填 i18n）、`kind: 'folder' | 'none'`、`conversations[]`。
- 标签默认从路径 basename 推导；调用方可传入 `rootLabel(path, allRoots)` 结果覆盖。

### Group header UI

- 文件夹图标 + 显示名 + 对话数；chevron 折叠/展开该组（默认展开）。
- 点击 chevron/整行切换折叠；点击对话行仍只切换会话（含恢复该对话的 `rootPath` 工作区）。
- 组头不新建对话、不打开文件夹（避免与对话切换语义打架）。
- 无项目组排在有文件夹的组之后（若两者都有）；仅无项目时只显示一组。

### File tree section

- 标题行「文件」+ chevron；默认展开（保持现有可浏览性），状态写入 `ui.store.fileTreeOpen` 并 `localStorage` 持久化（键 `conecode.fileTreeOpen`）。
- 折叠时只隐藏树内容，保留标题行；「打开文件夹 / 添加文件夹」入口仍可达（在展开内容内；无 `rootPath` 时折叠态也显示打开按钮，否则用户进不去）。
- 无 `rootPath`：标题行仍显示，内容区显示「打开文件夹」按钮（与现状一致，不受折叠影响）。

### Conversation row (unchanged behavior)

运行中 spinner、改动文件名副标题、hover 重命名/删除、行内重命名输入框 — 全部保留，仅在组内缩进渲染。

### i18n

新增键（en / zh / ja）：

- `sidebarNoProject` — "No project" / "无项目" / "プロジェクトなし"
- `sidebarFiles` — "Files" / "文件" / "ファイル"

### Testing boundary

- `conversationGroups.test.ts`：分组、排序、空 rootPath、标签覆盖、空列表。
- 不测 React 点击路径（无组件测试基建）；分组契约是本改动的可测核心。

## [S3] Out of Scope

- 不改对话创建/切换/持久化数据模型。
- 不把文件树做成按项目多实例。
- 不做拖拽重排、跨项目拖入、搜索过滤。
- 不改 Home / ChatView / 标题栏。

## Tasks

- [x] T1: 实现 `groupConversationsByRoot` 纯函数与单测 — acceptance: `conversationGroups.test.ts` 覆盖分组/排序/无项目/标签覆盖并全部通过 (covers: S2)
- [x] T2: Sidebar 按项目分组渲染对话 — acceptance: 对话列表以母文件夹为组头、子对话缩进；无项目单独一组；行内编辑/删除/运行态不变 (covers: S2; depends: T1)
- [x] T3: FileTree 可折叠并持久化 — acceptance: 底部「文件」区可折叠，状态跨刷新保持；无文件夹时仍可打开文件夹 (covers: S2)
- [x] T4: 补齐 en/zh/ja 文案 — acceptance: 新键三语齐全，界面无 raw key (covers: S2)
