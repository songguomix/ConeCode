# ConeCode Memory 2.0 分层长期记忆、云同步与 Dream 离线整理系统完整技术报告

**项目**：ConeCode（`v2.4.25`）  
**文档类型**：系统架构与核心技术报告  
**日期**：2026-11-23  

---

## 1. 系统概述与设计目标

传统 AI 编程客户端的长期记忆通常采用扁平字符串列表（例如按类别存储数十条短句并全量拼接进系统提示词），在真实多项目、多设备研发场景中存在五类结构性瓶颈：
1. **无项目隔离**：跨仓库的架构约定、构建命令与缺陷记录相互混杂，造成上下文串扰；
2. **无置信度与来源区分**：用户明确声明的硬约束与模型单次推断混为一谈，导致模型推断静默覆盖事实；
3. **无版本演化与冲突表达**：仅支持追加和删除，无法表达“新决策取代旧决策”，也无法撤销错误更新或处理多端并发编辑；
4. **检索粗放与噪声堆积**：全量注入浪费上下文窗口，寒暄与过程旁白持续污染记忆库；
5. **跨设备同步与隐私边界模糊**：缺乏增量游标、软删除墓碑与诚实的端到端加密能力界定。

**ConeCode Memory 2.0** 以**分层、带版本、严格项目隔离、本地优先（Local-First）**的架构全面重构了长期记忆子系统，并在其上构建了厂商中立的云同步协议（支持自托管 REST 网关与一键 Google Drive OAuth）以及面向历史会话的只读离线整理层 **Dream Wiki**。

---

## 2. 分层数据模型与项目硬隔离

### 2.1 五层记忆架构与语义类型体系

`src/core/memory/v2/types.ts` 定义了零 I/O 依赖的规范数据模型，作为本地存储、云端网关、同步引擎与前端面板的统一契约：

| 层级（`MemoryLayer`） | 作用域 | 典型内容 | 生命周期特征 |
| --- | --- | --- | --- |
| **`global`** | 跨全部项目（`projectId = null`） | 个人编码偏好、通用工作习惯、跨项目硬约束 | 长期持久，全局可见 |
| **`project`** | 单一 `projectId` | 项目架构、技术栈、技术决策、已知缺陷、约束 | 长期持久，严格按项目隔离 |
| **`episodic`** | 单一 `projectId` | 具体任务结果、成功经验、失败排障记录 | 按事件沉淀，可关联语义层 |
| **`semantic`** | 单一 `projectId` | 从多次情景提炼的可复用规律与决策依据 | 跨会话复用，关联来源情景 |
| **`working`** | 单一 `projectId` | 当前任务进度、临时待办与短期约束 | 带 TTL（默认 24 小时），可晋升或过期 |

每条 `MemoryRecord` 独立承载三组正交元数据：
- **语义类型（13 种 `MemoryType`）**：`user_fact`, `project_fact`, `architecture`, `technical_decision`, `decision_reason`, `constraint`, `task_result`, `progress`, `todo`, `success_experience`, `failure_experience`, `known_bug`, `reusable_knowledge`；
- **状态与来源（5 种 `MemoryStatus` × 6 种 `MemoryOrigin`）**：严格区分 `confirmed`（用户明确陈述）与 `inferred`（Agent 推断），另含 `pending`（待裁决）、`superseded`（已被取代）、`archived`（已归档）；来源标明 `user` / `extracted` / `manual` / `migration` / `tool` / `sync`；
- **关系图与同步信封**：支持 7 种有向关系（`related`, `supersedes`, `derived_from`, `caused_by`, `solves`, `part_of`, `conflicts_with`），以及稳定 UUID、`version`、`history: MemoryVersion[]`、`deviceId`、`syncStatus`、`contentHash` 与软删除时间戳 `deletedAt`。

### 2.2 全链路项目硬隔离

项目隔离并非前端过滤，而是在数据流每一道边界强制执行的不变量：
- `createRecord()` 拒绝创建缺少 `projectId` 的非 `global` 记录；
- `updateMemory()` 禁止在缺少 `projectId` 时将记录迁出全局层；
- `visibleToProject(record, projectId)` 统一作用于本地检索、关系图扩展、服务读取、远程同步导入及云端 `POST /search` 路由，确保项目 A 的任何记录永不暴露给项目 B。

---

## 3. 事件驱动抽取、质量门控与去重裁决

### 3.1 事件驱动价值信号抽取（`extract.ts`）

Memory 2.0 摒弃了定时轮询或每轮必抽的做法，改为**事件驱动抽取**：
- `detectValueSignals()` 仅在识别到明确架构变更、技术决策、问题解决、可复用规则、明确失败教训或实质性会话结束（存在真实价值信号或至少包含 6 条有效消息）时，由 `shouldExtract()` 放行抽取；
- 严格执行噪声治理：自动过滤寒暄、确认词（如“好的”“收到”“lgtm”）、未回答的问题、第一人称过程旁白（“我现在开始编辑文件”）、简单导航命令以及疑似密钥/凭据文本；
- `parseExtractionV2()` 容忍模型输出中的 Markdown 代码围栏与说明文字，且抽取器永远不可将模型推断直接标记为 `confirmed`。

### 3.2 确定性分类与质量评分（`classify.ts`）

`layerFor(type, scope)` 确定性地将语义类型映射到对应层级（如 `user_fact` → `global`、`task_result/success_experience/failure_experience` → `episodic`、`reusable_knowledge/decision_reason` → `semantic`、`todo/progress` → `working`、其余 → `project`）。

写入前的质量评分函数 `qualityScore()` 在 $[0, 1]$ 区间量化候选记忆的长期价值：
- 长度不足 12 字符、命中寒暄正则或噪声检测器直接判 0 分；
- 基础分 `0.35`，满足长度 ≥30（`+0.10`）、含因果连接词（`+0.15`）、含工程技术标识符（`+0.12`）、具备 `why` 决策依据（`+0.12`）、标签数 ≥2（`+0.06`）以及按 `importance` 加权（最高 `+0.10`），默认入库门槛 `minQuality = 0.40`。

### 3.3 五态去重与极性矛盾检测（`dedupeCandidates`）

针对同层同项目的活跃记录，引擎计算词集合 Jaccard 相似度与包含关系（包含即取 `0.90`），相似度阈值 `SIMILAR_THRESHOLD = 0.62`，输出五类精确决策：
1. **`reject`**：本次抽取内重复或质量分低于 `minQuality`；
2. **`reconcile`**：相似度达标且 `detectContradiction()` 检测到相反规则极性（如“必须/always”对比“禁止/never”），交由生命周期裁决器处理而非静默覆盖；
3. **`merge`**：同主题同极性且新表述显著更详尽（长度超过原记录 `1.15×`），合并保留并集细节；
4. **`reinforce`**：同主题重复观察，不新建重复条目，而是调用 `reinforce()` 提升重要性 `+0.06`；
5. **`add`**：无高相似既有记录，作为新记忆写入，并将新生成的语义层教训自动通过 `derived_from` / `related` 关联至同会话近期情景记录。

---

## 4. 版本化生命周期、冲突裁决与防误删保护

`src/core/memory/v2/lifecycle.ts` 实现了完整的版本化写路径，确保每一次变更均可追溯、可撤销、可三方合并：

1. **写前快照与版本上限**：所有写入统一经过 `updateMemory()`，在应用补丁**之前**将旧状态拍为不可变 `MemoryVersion` 快照追加至 `history`（上限 `MAX_HISTORY = 50`），随后递增 `version`、更新 `updatedAt` 与 `contentHash`。
2. **高重要性保护（`PROTECTED_IMPORTANCE`）**：高重要性记录默认禁止被自动抽取覆盖、归档或删除，必须由用户显式传入 `force: true` 才可变更。
3. **来源与置信度驱动的冲突裁决（`reconcile`）**：
   - **用户确认压倒模型推断**：新信息为 `status === 'confirmed' && confidence >= 0.9` 且旧记录非用户直述时，直接取代并保留旧版于历史；
   - **禁止推断覆盖事实**：旧记录为 `origin === 'user' && confidence >= 0.9` 而新信息为推断时，严格阻止覆盖，返回 `kept_both`；
   - **实质分歧并存**：对内容互不包含的实质性冲突（例如“服务部署在 A”与“服务部署在 B”），在缺乏压倒性置信度优势（`+0.20`）时不武断二选一，保留双版本并以 `conflicts_with` 边连接待人工裁决。
4. **软删除墓碑与版本化撤销**：`tombstone()` 设置 `deletedAt` 并将状态置为 `archived`，同步后确保在多设备间永不“复活”；`undoUpdate()` 恢复上一版本时本身也作为一次新版本写入，保持历史单调递增。

---

## 5. CJK 友好混合检索与受控上下文注入

`src/core/memory/v2/retrieval.ts` 实现了确定性的排序检索管线：

### 5.1 字段加权倒排索引与 CJK BM25

- `buildIndex()` 构建轻量内存倒排索引，通过字段重复实现原生加权：`title` 与 `tags` 权重 2×，`content` 与 `why` 权重 1×；
- `tokenize()` 对中文文本执行重叠双字切片（Bigram），配合英文词项切分，在无需外部原生分词库的情况下实现可靠的 CJK 全文匹配；
- 采用标准 BM25 相关性公式（$k_1 = 1.5, b = 0.75$）：
  $$\text{BM25}(D, Q) = \sum_{t \in Q} \ln\left(1 + \frac{N - n_t + 0.5}{n_t + 0.5}\right) \cdot \frac{f(t, D) \cdot (k_1 + 1)}{f(t, D) + k_1 \left(1 - b + b \cdot \frac{|D|}{\text{avgdl}}\right)}$$

### 5.2 多因素综合排序与受限关系图扩展

检索结果按综合分 `rankScore` 降序排列，结合相关性、重要性、置信度、90 天半衰期时效性及用户确认加权：

$$r(t) = \frac{1}{1 + \frac{\max(0, \text{now} - t_{\text{updated}})}{90 \text{ days}}}$$

$$\text{Rank}(h) = 0.55 \cdot \min\left(1, \frac{\text{BM25}}{6}\right) + 0.20 \cdot \text{importance} + 0.12 \cdot \text{confidence} + 0.08 \cdot r(t) + 0.05 \cdot \mathbb{I}[\text{status} = \text{confirmed}]$$

- **多维过滤**：支持按 `scope`、`projectId`、`layers`、`types`、`statuses`、`tags`、`importanceMin`、`confidenceMin`、`from/to` 时间窗口与 `sourceSessionId` 过滤；默认排除已删除、已归档与已被取代的条目。
- **受限关系图扩展（`expandRelated`）**：当 `includeRelated` 开启时，以前 5 条种子命中为起点沿关系图扩展（默认深度 1，最多 12 条），扩展命中按 `topScore * weight * 0.35` 衰减计分并标注溯源路径。
- **本地 + 云端混合合并（`mergeHybrid`）**：对同 UUID 命中比较版本号与得分，保留新版/高分条目并合并 `reasons[]` 与 `source` 溯源标签，同时在合并边界再次校验 `inScope`。
- **任务启动门控与定额注入**：`needsHistory()` 过滤纯寒暄/确认词；`formatRetrievalBlock()` 将高分命中格式化为带 `[layer/type | status | vN | source | importance]` 标签的紧凑块，严格截断在 `maxContextChars`（默认 6000 字符）以内，并显式提醒模型 `inferred` 结论需核实且用户声明优先。

---

## 6. 双向增量同步、三方合并与端到端加密

### 6.1 本地优先增量同步引擎（`sync.ts`）

`MemorySyncEngine` 基于 `CompositeStorageProvider` 实现本地优先、离线容忍的双向增量同步：
1. **追加式变更日志与幂等键**：每次本地变更生成单调递增 `seq` 与基于 `id:version:contentHash:op:at` 的 `changeId`；重复写入同一状态为无操作。拉取端维护 `appliedChangeIds`（上限 `APPLIED_ID_CAP = 3000`），重放变更流永不产生重复记录，回声变更（同 `deviceId`）自动跳过。
2. **增量 Push / Pull 与离线队列**：仅推送 `seq > pushCursor` 的本地变更，拉取 `since = cloudCursor` 之后的远程变更；云端不可用时诚实报告离线并保留本地待推队列，自动同步遵循指数退避重试 `min(5 min, 1s × 2^attempt)`。
3. **三方合并（`threeWayMerge`）与双版本冲突保留**：当双端并发修改同一记录时，通过 `findBase(local, remote.version)` 从本地历史快照中定位最近公共祖先：
   - 若仅单端修改某字段，自动采纳修改端；
   - `importance` 与 `confidence` 取 `max(l, r)`，`tags` 取集合并集，`why` 空值自动补全；
   - 若双端同时修改自由文本（`title`/`content`）或缺失公共祖先，则拒绝盲目覆盖，创建 `MemoryConflict` 同时保留 `local`、`remote` 与 `base`，等待用户通过 `resolve()` 显式选择 `keep_local`、`keep_remote` 或 `merge`。
4. **墓碑优先**：远程或本地软删除墓碑均不会被旧版更新复活。

### 6.2 厂商中立 REST 契约与一键 Google Drive 提供者

- **REST 云同步契约**：参考实现 `server/memory-cloud/server.mjs` 与生产级 `server/memory-cloud/postgres-schema.sql` 实现统一路由：`GET /health`（校验 `service: "conecode-memory-cloud"`）、`POST /search`（服务端强制项目隔离）、`GET/POST /changes`（游标增量与冲突返回）、`PUT/GET /objects/*`、`GET /devices`、`POST /devices/revoke`、`GET /usage`、`POST /backup`、`POST /restore` 及需精确租户名二次确认的 `POST /tenant/delete`。鉴权采用 `Authorization: Bearer` + `X-Tenant-Id` + `X-Device-Id`，吊销设备全路由返回 `403`。
- **一键 Google Drive 同步（`electron/memory-drive.ts`）**：主进程通过 OAuth 2.0 Loopback + PKCE 授权，将结构化快照与变更日志写入隐藏的 `appDataFolder`（不污染用户“我的云端硬盘”），写入采用 ETag 条件写防止并发覆写，刷新令牌与凭据使用 Electron `safeStorage` 加密落盘。

### 6.3 三层安全边界与诚实 E2E 加密（`security.ts`）

系统严格区分并向用户透明呈现三层安全边界：
1. **传输加密（`transport`）**：开启 `tlsOnly` 时拒绝向非回环地址发起明文 HTTP；
2. **服务端静态加密（`server-at-rest`）**：由部署方或 Google 托管；
3. **客户端端到端加密（`e2e`）**：基于 Web Crypto API 实现 **AES-256-GCM**（每次加密生成独立 12 字节随机 IV）与 **PBKDF2-SHA-256**（120,000 次迭代，固定应用盐 `conecode-memory2-e2e-v1`，进程内按口令缓存 `CryptoKey` 且永不落盘或打印日志）。上传前将 `title`, `content`, `why`, `tags`, `sourceSessionId`, `sourceEventId` 打包加密为 `e2e:v1:<iv>:<cipher>`，仅保留同步所需的非敏感信封元数据。系统诚实披露 E2E 权衡：开启 E2E 后服务端仅存密文，自动关闭服务端全文检索并回退至本地解密缓存检索。

---

## 7. 无损幂等迁移与 Dream 离线整理层

### 7.1 零破坏迁移管线（`migration.ts`）

`runMigration()` 支持从旧版 `memory.json` 及项目 `CLAUDE.md`/`AGENTS.md` 无损迁移：不修改源文件、先行写出备份、按稳定 ID 与源内容哈希保证幂等性、校验每条预期文本均已落地、跳过属于其他工作区的项目级条目（留待对应项目打开时迁移），并将无法自动归类的行标记 `needsTriage: true` 交由用户整理。

### 7.2 Dream 离线记忆整理（`src/core/memory/v2/dream/`）

Dream 是构建在 Memory 2.0 对象存储之上的**只读离线回看层**，不修改 `memory2.json` 中的任何结构化记录：
- **会话筛选与成本边界**：仅收集已结束且空闲 ≥10 分钟的历史会话（每轮最多 6 个会话、最多 12 个候选、每会话最多 6 个主题文件），transcript 截断至 24k 字符（单条消息 4k、工具参数 300 字符），按 transcript hash 跳过未变化会话，单阶段共享 120s 超时且失败最多以精简提示重试 1 次；
- **两阶段流水线**：
  1. **Analyzer**：逐会话分析并输出严格 JSON 校验后的主题文件（`slug` 严格限定 `[a-z0-9-]` 2–64 字符），覆盖前自动归档旧版本至 `history/<slug>-<ts>.md`（每主题保留最近 8 份 / 180 天）；
  2. **Organizer**：当存在新主题或上次整理失败时运行，确定性执行合并与退役——合并源主题正文保留全部事实、留下 `MOVED TO [[target]]` 存根、全局重写 `[[old]] → [[new]]` 链接，并从实际文件重新生成 `index.json` 与 `_index.md`；
- **双重脱敏与路径安全**：transcript 进入提示词前及 analyzer 产出落盘前均执行凭据脱敏（GitHub/OpenAI/AWS/Slack/JWT/私钥/`password=`）；主进程对象存储对 key 执行路径包含校验，拒绝绝对路径与 `..` 逃逸；
- **轻量上下文挂载**：后续会话启动时调用 `loadWikiContext()` 挂载 `_index.md` 及最相关的至多 2 个主题（总计 ≤2600 字符），与结构化记录的精确召回形成互补。

---

## 8. 工程验证与技术边界

### 8.1 自动化测试覆盖

Memory 2.0 与 Dream 子系统共包含 **22 个测试文件、204 个自动化测试用例**，覆盖本地核心引擎、迁移、加密、检索、同步、Dream 整理、Electron 磁盘持久化及云同步集成：
- **核心与本地持久化套件（20 个测试文件，196 个用例）**：涵盖 `classify.test.ts`、`extract.test.ts`、`lifecycle.test.ts`、`migration.test.ts`、`retrieval.test.ts`、`security.test.ts`、`service.test.ts`、`sync.test.ts`、`googleDrive.test.ts`、`dream/*`（29 个用例）、`electron/memory2.store.test.ts`、`src/stores/memoryIntegration.test.ts`、`memoryDream.*.test.ts` 及兼容旧版测试，在离线沙箱环境下 100% 通过。
- **回环网络集成套件（2 个测试文件，8 个用例）**：`cloud.integration.test.ts`（5 个多设备同步/E2E/鉴权/租户删除集成用例）与 `electron/memory-drive.test.ts`（3 个 OAuth Loopback/ETag 并发冲突用例），在允许本地回环端口监听的环境下完整验证真实网络协议。

### 8.2 已知技术边界与演进方向

1. **向量语义检索扩展**：默认语义提供者显式声明 `isSemantic = false`（不伪造向量搜索），生产环境可通过 `setSemanticProvider()` 无缝接入本地或远程 Embedding 引擎。
2. **云端存储扩展**：零依赖参考服务采用单租户原子 JSON 文件，大规模生产部署可基于已提供的 `postgres-schema.sql` 与对象存储实现相同 REST 契约；Google Drive 端受限于文件 API 语义，ETag 保护更新但不具备首次建文件原子锁。
3. **跨设备项目标识**：优先通过项目标记或 Git `origin` 远程地址对齐跨设备 `projectId`；无标记的非 Git 目录退化为本机路径哈希。
