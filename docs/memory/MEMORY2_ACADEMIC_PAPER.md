# Memory 2.0：面向桌面编码智能体的项目隔离分层记忆、三方同步与只读离线 Wiki 整理架构

**Memory 2.0: Project-Isolated Layered Memory, Three-Way Synchronization, and Read-Only Offline Wiki Consolidation for Desktop Coding Agents**

---

## 摘要

大语言模型编码智能体在跨会话、多项目、多设备的长期软件工程协作中，普遍受限于传统扁平记忆列表的固有缺陷：跨项目上下文串扰、模型推断静默覆盖用户硬约束、缺乏版本历史与并发冲突裁决、检索噪声堆积以及云同步与隐私安全边界模糊。本文以开源桌面 AI 编码工作台 ConeCode 的 **Memory 2.0** 子系统为研究对象，提出并形式化了一套**本地优先、项目硬隔离、版本化可同步的分层长期记忆架构**。系统将记忆划分为 Global、Project、Episodic、Semantic、Working 五个层次，通过事件驱动价值信号抽取、确定性质量评分与极性矛盾检测实现写入前去重与冲突保护；在生命周期层引入写前不可变版本快照、高重要性写保护、来源置信度裁决与软删除墓碑；在检索层设计融合字段加权 CJK-BM25、90 天半衰期时效衰减、置信度加权与受限关系图扩展的混合排序模型；在同步层实现基于单调游标、幂等变更键、三方字段级合并与 Web Crypto AES-256-GCM 端到端加密的厂商中立协议（兼容自托管 REST 网关与 Google Drive OAuth）；并在其上构建了只读离线回看层 **Dream Wiki**，通过双重脱敏与确定性合并将空闲历史会话沉淀为结构化知识网络。在 22 个自动化测试套件（204 个测试用例）上的系统验证表明，该架构在多项目隔离、防推断覆盖、并发冲突保留、端到端加密与离线知识整理方面均满足严格的工程不变量。

**关键词**：编码智能体；分层长期记忆；项目隔离；CJK-BM25 混合检索；三方同步；端到端加密；离线 Wiki 整理

---

## Abstract

Long-horizon software engineering with large language model (LLM) coding agents across multiple projects and devices exposes fundamental limitations in conventional flat-list memory stores: cross-project context leakage, silent overwriting of explicit user constraints by agent inferences, lack of version history and conflict resolution, retrieval noise accumulation, and blurred cloud-privacy boundaries. This paper formalizes **Memory 2.0**, the local-first, project-isolated, versioned long-term memory architecture implemented in the open-source desktop AI coding workspace ConeCode. Memory 2.0 organizes knowledge into five scoped layers (Global, Project, Episodic, Semantic, and Working) enforced as hard invariants across storage, retrieval, graph expansion, and cloud APIs. Write-time quality control combines event-driven value-signal extraction, deterministic quality scoring, Jaccard/containment deduplication, and polarity-based contradiction detection. Every mutation preserves pre-patch immutable version snapshots, enforces high-importance write guards, reconciles provenance and confidence without allowing inferences to override confirmed user facts, and propagates deletions via tombstones. Active retrieval integrates field-boosted CJK-aware BM25, 90-day half-life recency decay, confidence/status weighting, and bounded relation-graph expansion. Cross-device synchronization relies on an append-only cursor log, idempotent change IDs, ancestor-based three-way merging, and client-side AES-256-GCM end-to-end encryption (PBKDF2-SHA-256, 120k iterations) over a vendor-neutral REST contract and a one-click Google Drive `appDataFolder` provider. Complementing structured recall, an offline read-only layer (**Dream**) consolidates idle sessions into double-redacted, link-rewritten Markdown wikis without mutating structured records. Verification across 22 automated test suites (204 tests) confirms strict adherence to project isolation, non-destructive reconciliation, conflict preservation, and E2E security boundaries.

**Keywords**: Coding Agents; Layered Long-Term Memory; Project Isolation; CJK-BM25 Hybrid Retrieval; Three-Way Sync; End-to-End Encryption; Offline Wiki Consolidation

---

## 1. 引言

现代软件开发具有高度的跨会话连续性与多项目并行性：开发者在同一台桌面设备上往往同时维护多个技术栈迥异的代码仓库，并在笔记本与台式机之间切换。早期编码智能体通常采用“扁平字符串列表 + 全量系统提示词拼接”的方式保存记忆，然而随着会话规模增长，此类设计暴露出五类根本性问题：

1. **作用域污染（Scope Leakage）**：不同仓库的架构决策、部署约定与已知缺陷混杂在同一列表中，导致模型在项目 A 中误用项目 B 的命令或约束。
2. **认识论混同（Epistemic Conflation）**：用户明确下达的硬性规范（Confirmed Fact）与模型在某次排障中做出的临时推测（Agent Inference）缺少状态区分，后续自动抽取极易用低置信度推断静默覆盖高可信事实。
3. **不可逆变更与冲突丢失（Irreversible Overwrite）**：缺少版本快照与多设备并发检测机制，错误更新无法回滚，多端同时编辑同一记忆时后写覆盖先写造成知识丢失。
4. **检索退化与噪声膨胀（Retrieval Degradation）**：全量拼接迅速侵占上下文窗口，且缺乏事件驱动门槛，导致寒暄、过程旁白与过期进度不断稀释高价值知识。
5. **云端安全与检索权衡不透明**：将传输加密、服务端静态加密与客户端端到端加密（E2E）混为一谈，甚至在声称 E2E 加密的同时虚报支持云端全文搜索。

针对上述挑战，本文系统阐述并形式化了 ConeCode 的 **Memory 2.0** 及其上层离线整理系统 **Dream**。核心贡献如下：
- **五层项目硬隔离模型与版本化生命周期**：在存储、检索、关系扩展与云网关四道边界强制实施项目作用域不变量，建立带写前快照、高重要性保护、来源置信度裁决与墓碑删除的完整状态机；
- **事件驱动抽取与极性矛盾检测**：以确定性质量评分与正负极性词典识别潜在规则冲突，将矛盾候选自动路由至可逆裁决流程而非覆盖；
- **CJK 友好 BM25 多维混合排序**：构建无需原生分词依赖的中文双字切片 BM25 索引，融合字段加权、时效衰减、重要性/置信度与受限关系图扩展；
- **离线容忍三方同步与诚实 E2E 边界**：实现游标增量同步、基于本地历史祖先的字段级三方合并、冲突双版本保留以及 AES-256-GCM 端到端加密（并显式处理密文下的本地回退检索）；
- **互补式只读离线 Dream Wiki**：在不篡改结构化记忆库的前提下，对空闲历史会话执行双重脱敏分析与确定性图谱合并，提供跨会话事后纠错与轻量索引挂载。

---

## 2. 形式化数据模型与硬隔离不变量

定义记忆记录集合 $\mathcal{R}$，每条记录 $r \in \mathcal{R}$ 为结构化元组：
$$r = \langle \text{id}, \ell \in \mathcal{L}, \tau \in \mathcal{T}, p \in \mathcal{P} \cup \{\bot\}, \text{title}, \text{content}, \text{tags}, \iota, \gamma, \sigma, \omega, v, \mathcal{E}, \mathcal{H}, d, h_c, t_{\text{del}} \rangle$$
其中：
- **五层集合** $\mathcal{L} = \{\text{global}, \text{project}, \text{episodic}, \text{semantic}, \text{working}\}$；
- **语义类型** $\mathcal{T}$ 包含 13 类工程知识原语（从 `user_fact`、`architecture`、`technical_decision` 到 `known_bug`、`reusable_knowledge`）；
- **权重与可信度** $\iota \in [0,1]$（importance）、$\gamma \in [0,1]$（confidence）；
- **状态集合** $\sigma \in \{\text{confirmed}, \text{inferred}, \text{pending}, \text{superseded}, \text{archived}\}$；
- **有向关系集** $\mathcal{E} \subseteq \text{UUID} \times \{\text{related}, \text{supersedes}, \text{derived\_from}, \text{caused\_by}, \text{solves}, \text{part\_of}, \text{conflicts\_with}\}$；
- **不可变版本历史** $\mathcal{H} = [s_1, \dots, s_m]$（$m \le 50$），以及设备标识 $d$、内容哈希 $h_c$ 与软删除墓碑 $t_{\text{del}} \in \mathbb{N} \cup \{\bot\}$。

系统在所有读写边界强制维持三条核心不变量：
- **不变量 M1（项目作用域硬隔离）**：$\forall r \in \mathcal{R},\; (\ell = \text{global} \iff p = \bot)$。对当前工作区项目 $p^\star$，可见性谓词定义为 $\text{visible}(r, p^\star) \equiv (r.\ell = \text{global}) \lor (p^\star \neq \bot \land r.p = p^\star)$，统一作用于本地检索、关系图遍历、同步落盘与云端搜索接口。
- **不变量 M2（认识论单调保护）**：自动抽取器产出的候选永不可直接赋予 `origin = user` 或覆盖已存在的用户确认记录（$\omega = \text{user} \land \gamma \ge 0.9$）；高重要性记录（$\iota \ge \iota_{\text{prot}}$）的覆写与删除必须携带显式人工 `force` 标记。
- **不变量 M3（版本可逆与墓碑不复活）**：任意更新必须先将变更前状态追加至 $\mathcal{H}$ 再递增 $v$；软删除以 $t_{\text{del}} \neq \bot$ 与 $\sigma = \text{archived}$ 传播，任何旧版本远程同步消息均不得复活已墓碑化的记录。

---

## 3. 核心机制与算法设计

### 3.1 事件驱动抽取、质量门控与五态去重

传统定时抽取易引入大量低信息量对话碎片。Memory 2.0 采用事件驱动触发机制：仅在 `detectValueSignals()` 捕获决策、架构变更、问题解决、可复用规则、失败教训或实质性会话结束信号时调用抽取器。

对于抽取并分类后的候选记忆 $c$，系统首先计算确定性质量分 $Q(c) \in [0, 1]$（剔除长度 $<12$ 字符、寒暄与过程旁白；按文本长度、因果连接词、技术标识符、`why` 依据、多标签及重要性累加，默认门槛 $Q_{\min} = 0.40$）。随后针对同层同项目的活跃记录集 $\mathcal{R}_{\text{pool}}$，计算词集相似度：
$$\text{sim}(c, e) = \max\Big(\text{Jaccard}(\text{terms}(c), \text{terms}(e)),\; 0.9 \cdot \mathbb{I}[\text{contained}(c, e)]\Big)$$

设最相似记录为 $e^\star = \arg\max_{e \in \mathcal{R}_{\text{pool}}} \text{sim}(c, e)$，当 $\text{sim}(c, e^\star) \ge 0.62$ 时触发三分支判定：
1. 若 `detectContradiction(c, e*)` 检测到正负极性对立（例如“必须/always”对比“禁止/never”），输出 **`reconcile`**；
2. 若同极性且 $|c.\text{content}| > 1.15 \cdot |e^\star.\text{content}|$，输出 **`merge`**（合并正文与标签并保留 `part_of` 边）；
3. 否则输出 **`reinforce`**（不新建记录，仅将 $e^\star.\iota \leftarrow \min(1, e^\star.\iota + 0.06)$）。

在 `reconcile(e*, c)` 中，若 $e^\star$ 为受保护高重要性记忆或用户直述事实而 $c$ 为推断，或二者文本互不包含且新信息未具备决定性用户确认或 $+0.20$ 以上置信度优势，系统返回 `kept_both`，将新候选置为 `pending` 并建立 `conflicts_with` 边交由人工裁决，彻底消除静默误覆盖。

### 3.2 字段加权 CJK-BM25 与多维混合检索

为在不引入重型原生分词与向量数据库依赖的前提下保证中英双语工程检索精度，`retrieval.ts` 构建了轻量级字段加权倒排索引：对每条记录的 `title` 与 `tags` 词项重复 2 次，`content` 与 `why` 保持 1 次；中文字符流经重叠双字切片（Bigram）切分后，采用标准 BM25（$k_1 = 1.5, b = 0.75$）计算相关性得分 $s_{\text{bm25}}$。

结合 90 天半衰期时效衰减函数 $r(t) = (1 + \Delta t_{\text{days}} / 90)^{-1}$，定义综合排序函数：
$$\text{Rank}(h) = 0.55 \cdot \min\left(1, \frac{s_{\text{bm25}}}{6}\right) + 0.20 \cdot \iota + 0.12 \cdot \gamma + 0.08 \cdot r(t_{\text{updated}}) + 0.05 \cdot \mathbb{I}[\sigma = \text{confirmed}]$$

排序完成后，引擎执行三步增强：
1. **受限关系图扩展**：若启用 `includeRelated`，以前 5 条高分命中为种子沿关系图遍历（默认深度 1，最多 12 条），扩展节点以 $0.35 \cdot w_{\text{edge}} \cdot s_{\text{top}}$ 计分并记录溯源路径 `related via <kind>`；
2. **本地与云端混合归并（`mergeHybrid`）**：对相同 UUID 的双源命中，优先保留版本号更高者（同版本取高分），合并 `reasons[]` 与 `source` 溯源标注，并重新校验项目可见性；
3. **定额上下文注入**：任务启动前先由 `needsHistory()` 过滤无意义寒暄，再由 `formatRetrievalBlock()` 将排名前列的命中按字符上限（默认 6000 字符）压缩注入，每条显式标注 `[layer/type | status | vN | source | importance]`，引导模型审慎对待 `inferred` 结论。

### 3.3 双向增量同步、三方合并与端到端加密

多设备协同由 `MemorySyncEngine`（`sync.ts`）驱动，完整增量同步周期如算法 1 所示：

```text
Algorithm 1: Local-First Incremental Bidirectional Sync with 3-Way Merge
Input:  LocalState S = (records, changes, pushCursor, cloudCursor, appliedIds)
Output: Updated LocalState S', SyncReport rep

1. if ¬cloudAvailable() then
       S.offlineQueueLength ← |{c ∈ S.changes | c.seq > S.pushCursor}|
       return (S, offline=true)
2. batch ← {c ∈ S.changes | c.seq > S.pushCursor}
3. if batch ≠ ∅ then
       res ← pushChanges(batch)        // server enforces idempotent changeId & conflict check
       advance S.pushCursor to max accepted seq; record server-reported conflicts
4. remote ← pullChanges(since = S.cloudCursor, limit = 200)
5. for each ch ∈ remote.changes do
       if ch.changeId ∈ S.appliedIds ∨ ch.deviceId = S.deviceId then skip
       if ch.op = delete ∨ ch.record.deletedAt ≠ null then
           applyTombstone(S, ch)       // tombstone always wins over resurrection
       else if ¬exists(ch.memoryId) then
           insertSynced(S, ch.record)
       else if ch.record.version = cur.version ∨ localDirty(cur.id) then
           base ← findNewestHistoryAtOrBelow(cur.history, ch.record.version)
           if base ≠ null ∧ threeWayMerge(base, cur, ch.record).ok then
               bumpVersionAndAppendChange(merged)
           else
               recordConflict(cur, ch.record, base)   // preserve BOTH versions
       else if ch.record.version > cur.version then
           replaceWithRemote(S, ch.record)
       S.appliedIds.add(ch.changeId)
6. S.cloudCursor ← max(S.cloudCursor, remote.cursor)
7. compactAppliedLog(S.changes, keepTail=500) and return (S', rep)
```

在字段级三方合并（`threeWayMerge`）中，若本地与远程修改了互不相交的字段则无损自动合并；数值元数据 `importance`/`confidence` 采用单调最大值合并，`tags` 采用集合并集；自由文本字段（`title`/`content`）的双端并发修改绝不自动覆盖，而是持久化为 `MemoryConflict` 交由人工选择 `keep_local`、`keep_remote` 或 `merge`。

**诚实三层安全与 E2E 加密**：系统严格区分传输加密（非回环地址强制 TLS）、服务端静态加密与客户端端到端加密（`e2e`）。在 E2E 模式下，客户端使用 Web Crypto API 以 **PBKDF2-SHA-256**（120,000 次迭代，进程内内存缓存 `CryptoKey`）派生 256 位密钥，以每次随机 12 字节 IV 的 **AES-256-GCM** 加密 `title`、`content`、`why`、`tags` 及会话溯源 ID，封装为 `e2e:v1:<iv>:<cipher>` 后上传。由于服务端仅持有密文，系统在 E2E 激活时显式禁用服务端全文检索并自动回退至本地解密缓存检索，杜绝虚假安全承诺。

此外，同步层同时支持两类后端：**厂商中立 REST 网关**（配套零依赖参考服务与 PostgreSQL 生产 Schema，支持多租户隔离、设备吊销、备份恢复与精确租户名确认销毁）以及**一键 Google Drive 提供者**（主进程 OAuth 2.0 Loopback + PKCE 写入隐藏 `appDataFolder`，采用 ETag 条件写防并发覆盖，凭据经 Electron `safeStorage` 加密）。

### 3.4 互补式只读离线整理：Dream Wiki

结构化记录擅长精确条件召回，但在跨多轮复杂排障后容易出现碎片化。为此，Memory 2.0 之上构建了只读离线回看层 **Dream**（`src/core/memory/v2/dream/`），灵感源自“动态工作流离线做梦（Dreaming）”思想：
- **隔离与触发**：仅处理已结束且空闲 $\ge 10$ 分钟的历史会话（每轮上限 6 个会话，按 transcript 哈希跳过未变更会话），支持手动触发与每日自动整理，且绝不修改 `memory2.json`；
- **双重脱敏与零删除**：输入 transcript（截断 24k 字符）与模型产出正文均经过凭据脱敏正则清洗；写入覆盖前先归档旧版至 `history/`（每主题保留 8 份 / 180 天）；
- **Analyzer → Organizer 确定性收口**：Analyzer 逐会话产出严格 JSON 校验的 Markdown 主题；Organizer 在存在新主题时执行确定性合并与退役——合并保留全部事实、为迁移条目留下 `MOVED TO [[target]]` 存根并重写全库 `[[old]] → [[new]]` 双向链接，最后由磁盘文件重建 `index.json` 与 `_index.md`；
- **轻量上下文挂载**：后续会话启动时仅挂载索引与最相关的至多 2 个主题（$\le 2600$ 字符），与 Memory 2.0 的结构化检索形成“精确事实 + 全局导览”的双轨互补。

---

## 4. 工程实现与验证评估

### 4.1 无损迁移与幂等性保障

针对从旧版扁平记忆（`memory.json`）及项目文档（`CLAUDE.md`/`AGENTS.md`）向 Memory 2.0 的平滑过渡，`migration.ts` 实施非破坏式迁移：只读解析源数据并先写备份，以稳定 ID 与源哈希确保重复执行幂等，迁移后逐条校验预期文本完整性；属于其他工作区的项目条目留在旧库等待对应项目打开时迁移，无法归类条目显式打标 `needsTriage`。

### 4.2 自动化测试验证矩阵

整个 Memory 2.0 与 Dream 子系统由 **22 个测试套件、共 204 个自动化测试用例**覆盖，具体分布如表 1 所示：

| 验证维度 | 测试套件 | 套件数 | 用例数 | 核心验证契约 |
| --- | --- | ---: | ---: | --- |
| 分类、抽取与生命周期 | `classify.test.ts`, `extract.test.ts`, `lifecycle.test.ts`, `service.test.ts` | 4 | 35 | 价值信号抽取、噪声拦截、极性矛盾检测、版本快照与撤销、高重要性保护、防推断覆盖 |
| 混合检索与兼容层 | `retrieval.test.ts`, `memory.test.ts`, `memoryFiles.test.ts`, `quickCapture.test.ts` | 4 | 89 | CJK 双字 BM25、字段加权、时效衰减、关系图扩展、项目硬隔离与本地+云端合并 |
| 同步、安全与迁移 | `sync.test.ts`, `security.test.ts`, `migration.test.ts`, `googleDrive.test.ts` | 4 | 22 | 游标增量、幂等 `changeId`、墓碑不复活、三方合并与冲突保留、AES-256-GCM 往返、无损迁移 |
| Dream 离线整理与宿主集成 | `dream/*.test.ts`, `electron/memory2.store.test.ts`, `memoryIntegration.test.ts`, `memoryDream.*.test.ts` | 8 | 50 | 双重脱敏、路径逃逸拦截、确定性合并与链接重写、2600 字符挂载预算、Electron 原子落盘 |
| 回环网络端到端集成 | `cloud.integration.test.ts`, `electron/memory-drive.test.ts` | 2 | 8 | 双设备 REST 同步与冲突解决、E2E 密文同步与服务端禁搜、Bearer 鉴权、OAuth Loopback 与 ETag 冲突 |
| **合计** | **Memory 2.0 + Dream 全链路** | **22** | **204** | **离线核心 20 套件 196 用例 100% 通过；网络集成 2 套件 8 用例需本机回环监听权限** |

---

## 5. 讨论与局限性

Memory 2.0 在工程完备性与诚实边界方面做出了若干明确取舍，同时也留下了清晰的后续研究方向：
1. **词法检索与神经语义检索的融合**：当前默认语义提供者显式声明为词法模式（`isSemantic = false`），在跨术语同义召回上弱于稠密向量检索；通过既有的 `setSemanticProvider()` 接口集成轻量本地 Embedding 模型是自然的下一步演进。
2. **文件型云端与事务型云端的语义差异**：Google Drive `appDataFolder` 极大降低了个人用户的零配置同步门槛，但其本质为文件快照 API（ETag 仅保护已有文件更新，无法完全消除双端首次建文件竞态），多端高并发团队场景仍应部署基于 PostgreSQL 契约的 REST 网关。
3. **E2E 加密与云端检索的固有权衡**：在零知识 E2E 模式下，服务端无法对密文执行明文倒排索引，客户端自动回退至本地解密缓存检索；未来可探索客户端增量本地索引持久化以降低大规模记忆库下的内存重建开销。
4. **Dream 整理的主动按需读取**：当前 Dream Wiki 在会话启动时静态挂载索引与至多 2 个主题，尚未向 Agent 开放专用的按需 Wiki 检索工具，后续可将其接入统一只读工具集以支持深层主题按需展开。

---

## 6. 结论

本文形式化并系统阐述了 ConeCode Memory 2.0 及其上层 Dream 离线整理系统的技术架构。通过建立五层项目硬隔离模型、事件驱动价值抽取与极性冲突裁决、版本化不可逆保护与墓碑同步、字段加权 CJK-BM25 混合检索、基于历史祖先的三方合并与诚实 AES-256-GCM 端到端加密，并辅以双重脱敏的只读 Dream Wiki 离线整理，系统在保证本地优先响应速度与隐私安全底线的前提下，为桌面编码智能体提供了可追溯、抗污染、跨设备一致的长期记忆基础设施。
