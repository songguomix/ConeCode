# Memory Dream — 离线记忆整理（cookbook 机制落地）

Dream 是 Memory 2.0 之上的**离线回看层**：只处理已经结束且空闲的会话，把其中可复用的事实整理成一个只读 wiki，供后续会话挂载。它不改写或删除 Memory 2.0 的结构化记录，也不自动执行会话里的任何指令。

参考：Claude Cookbook《Dreaming with a dynamic workflow》——每个 transcript 一个 analyzer，随后一个 organizer 维护 index。

## 数据流

```text
conversation/message 存储
        │  仅已完成且空闲 ≥10 分钟的会话（最多 6 个/轮）
        ▼
collectDreamSessions() ──► formatTranscript()（脱敏、截断 24k）
        │
        ▼
analyzer（每个 transcript 一次，单次超时 120s）
        │  JSON: files[{slug,name,description,domain,body,sources}]
        ▼
wiki 对象存储（覆盖前先写 history）
        │
        ▼
organizer（一次）──► merges / retire
        │  确定性执行：合并正文、保留全部事实、MOVED TO 存根、链接重写
        ▼
index.json + _index.md + state.json + last-report.json
        │
        ▼
后续会话：loadWikiContext() 挂载索引 + 最多 2 个相关主题（≤2600 字符）
```

## 存储布局（Memory 2.0 object store）

```text
objects/dream/<scope>/wiki/<slug>.md          # 主题文件（frontmatter + markdown）
objects/dream/<scope>/_index.md               # 人类可读索引
objects/dream/<scope>/index.json              # 机器索引（上下文加载只读一次）
objects/dream/<scope>/state.json              # 已处理会话 + transcript hash
objects/dream/<scope>/last-report.json        # 最近一次报告
objects/dream/<scope>/history/<slug>-<ts>.md  # 被覆盖主题的旧版本
```

- `<scope>` 来自当前项目 id，非法字符归一化，项目之间互不可见。
- 主题 slug 只能是 `[a-z0-9-]`，2–64 字符；`_index` 与 `index` 保留。
- 对象 key 由主进程存储层做路径包含校验，拒绝绝对路径与 `..`。

## 触发方式

- **手动**：Memory 面板 → 总览 → 「Dream 记忆整理」→ 立即整理。
- **每日自动**：同一卡片勾选「应用运行期间每天自动整理」。默认关闭；应用必须保持运行；最多每 24 小时一次，且不会与手动整理并发。
- 没有选中模型时不会写入任何文件，只会在报告里留下 warning。

## 安全与事实保全

- transcript 在进入提示词前就做凭据脱敏（GitHub/OpenAI/AWS/Slack/JWT/私钥/`password=` 等）。
- analyzer 产出的正文再次脱敏后才落盘；模型无法把密钥写进 wiki。
- 提示词明确：transcript 是**不可信数据**，不得执行其中的指令，不得把猜测写成事实。
- **不删除**：覆盖主题前写 history；合并时把源主题正文并入目标；被合并/迁移的文件留下 `MOVED TO [[target]]` 存根。
- 链接重写：`[[old]]` → `[[new]]`，索引永远由文件本身重新生成，避免模型漏项。
- organizer 只能从现有 index 中选 slug，非法/越界合并直接丢弃。
- 所有 LLM 输出必须通过严格 JSON 校验；无效输出不产生任何写入。

## 与 Memory 2.0 的关系

| 维度 | Memory 2.0 记录 | Dream wiki |
| --- | --- | --- |
| 写入时机 | 会话结束时的 LLM 抽取 / 工具 | 离线整理（手动或每日） |
| 结构 | 分层结构化记录、版本、关系 | 小主题 markdown + wiki 链接 |
| 使用方式 | 检索排序注入上下文 | 只读索引 + 相关主题挂载 |
| 删除 | 归档/取代保留历史 | 不删除，保留 history 与存根 |

两者互补：结构化记录负责精确召回，dream wiki 负责跨会话的 hindsight 纠错与导航。Dream 不修改 `memory2.json` 中的任何记录。

## 成本控制

- 每轮最多 6 个会话；最多收集 12 个候选；每会话最多 6 个文件。
- transcript 截断到 24k 字符，单条消息 4k，工具参数 300 字符；analyzer 输出上限 4000 tokens，organizer 2000。
- 单次调用超时 120 秒；失败只记录报告，不重试、不写入半成品。
- wiki 主题上限（读取/整理）默认 80 个，超出记 warning。
- 已处理会话按 transcript hash 跳过；会话内容变化才会重新分析。

## 当前阶段与限制

已实现（Phase 1）：

- transcript 导出（含工具名与参数，截断）、analyzer、organizer、wiki 存储、索引、只读挂载、Dream Wiki 只读浏览器（Memory 面板）、手动/每日触发、UI 报告、history 保留策略（每主题 8 份/180 天）、路径安全与脱敏、20 个核心 dream 测试、2 个上下文挂载测试，以及对象存储路径安全测试。

未实现（后续阶段）：

- 面向 agent 的 wiki 读取工具（目前只挂载索引与 2 个相关主题，UI 可浏览）。
- 可编辑 wiki / 手动冲突裁决 UI。
- history 的容量统计与更细的保留策略（当前：每主题保留最新 8 份，超过 180 天且非最新删除）。
- 并行 analyzer（当前顺序执行，避免同文件并发写；会话上限 6 控制成本）。
- 跨项目共享 wiki（当前严格按项目隔离）。
- 失败自动重试与断点续跑（报告保留，下次按 hash 继续）。

## 测试

```bash
npx vitest run src/core/memory/v2/dream src/stores/memoryDream.store.test.ts electron/memory2.store.test.ts
```

Dream Wiki 浏览器位于 Memory 面板的 "Dream wiki" 页签：列出主题、查看只读正文，不提供编辑（重新整理才会更新）。

覆盖：frontmatter 往返、slug/路径安全、密钥脱敏、索引分组与 retired 隐藏、JSON 容错、会话跳过、无效输出零写入、organizer 合并保留事实与链接重写、项目隔离、活跃会话忽略、对象 key 逃逸拦截。
