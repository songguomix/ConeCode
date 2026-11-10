# ConeCode Memory 2.0

Memory 2.0 replaces the old flat `memory.json` list with a layered, versioned,
project-isolated long-term memory engine.

## Layers

| Layer | Scope | Typical content |
| --- | --- | --- |
| Global | every project | user preferences, working habits, cross-project constraints |
| Project | one project id | architecture, stack, decisions, known bugs, progress |
| Episodic | one project id | a task, incident, fix or failed attempt |
| Semantic | one project id | reusable lessons distilled from one or more episodes |
| Working | one project id | current task progress / temporary constraints (TTL) |

`createRecord()` refuses a non-global record without a `projectId`, and
`visibleToProject()` is applied at retrieval, relation expansion, service reads
and the cloud server. Isolation is not a UI filter.

## Record lifecycle

```
collect → understand → extract → classify → dedupe → relate → save
        → retrieve → update → version → archive / tombstone
```

Every record has: stable UUID, title/content, type, layer, projectId, tags,
importance, confidence, status, origin, source session/event, timestamps,
version, relations, history, deviceId, syncStatus, contentHash, deletedAt.

Statuses: `confirmed` (user stated), `inferred` (agent conclusion), `pending`,
`superseded`, `archived`. The extractor can never promote an inference to
`confirmed`.

`updateMemory()` snapshots the previous version before applying a patch, so undo
and version restore are real. High-importance records require an explicit
`force` for overwrite/delete/archive.

## Extraction

Extraction is event-driven, not timer-driven. `detectValueSignals()` looks for
decisions, architecture changes, solved problems, reusable rules, failures and
explicit session end. `shouldExtract()` requires a meaningful signal (a lone
"done" is not enough). The model returns structured JSON; `parseExtractionV2()`
is tolerant of fences/prose and rejects secrets.

`dedupeCandidates()` decides add / reinforce / merge / reject. Similar records
with opposite polarity go through `reconcile()`: a confirmed user correction can
supersede an inference; an inference cannot overwrite a confirmed fact; unclear
or materially different claims keep both, the incoming one `pending` and linked
with `conflicts_with`.

Noise hygiene is deliberately strict: unanswered questions, first-person
process narration ("I will now edit the file"), greetings, trivial navigation
commands and short task chatter never become durable memory. Session-end
extraction runs only when a real value signal exists or the session has at least
six substantive messages. The current task is tracked as working memory only for
substantive tasks, and the UI setting can turn that off.

Semantic lessons are automatically linked to the recent episodes from the same
session (`derived_from` / `related`).

## Retrieval

`searchMemory()` provides:

- CJK-aware BM25 full-text (overlapping bigrams for Chinese),
- metadata filters: project, layer, type, status, tags, importance, confidence,
  time range, source session,
- bounded relation expansion,
- local + cloud hybrid merge with source/version provenance,
- optional semantic provider (the default is explicitly lexical and reports
  `isSemantic=false`; no fake vector search).

At task start the Agent calls `beginTask()` only when `needsHistory()` is true.
Only the ranked, character-capped block is injected into the system prompt.
During a task the Agent can call the `memory_search` tool. At task end,
`endTask()` runs only at value nodes; leaving/deleting a conversation triggers a
guarded one-time session-end extraction.

## Storage and sync

- `MemoryStorageProvider` is the only storage interface.
- Local: atomic JSON through Electron (`memory2.json`), device id, project id,
  object directory, backup/restore.
- Cloud: vendor-neutral REST client (`src/core/memory/v2/storage/cloud.ts`)
  and a Google Drive provider (`src/core/memory/v2/storage/googleDrive.ts` +
  `electron/memory-drive.ts`). Google Drive uses OAuth 2.0 loopback/PKCE,
  appDataFolder JSON snapshots and ETag-conditional writes.
- Composite: local-first, cloud as an addition; cloud failure degrades to local.
- Sync: append-only change log + cursor, idempotent change ids, tombstones,
  offline queue, exponential retry, 3-way merge when safe, otherwise both
  versions preserved as a conflict with human resolution.
- Cloud credentials are encrypted at rest with Electron `safeStorage` when
  available. E2E (AES-GCM/PBKDF2) disables server-side search by design.

The REST contract and PostgreSQL schema are in
[`memory-2.0-cloud.md`](./memory-2.0-cloud.md) and
`server/memory-cloud/postgres-schema.sql`.

## Migration

`runMigration()` reads the old `memory.json` and effective
`CLAUDE.md`/`AGENTS.md` files **without modifying them**, writes a backup,
maps rows into the new model, verifies every expected text exists, then applies
additively. It is idempotent via stable ids + source hashes. Project-scoped rows
belonging to another workspace are left in the old store; opening that workspace
later runs its own pass. Unclassifiable lines land in `needsTriage`.

## Known limitations

- The reference cloud server stores a tenant in one atomic JSON file. It is a
  real, tested service, but production should use the PostgreSQL + S3/R2
  gateway described in the contract.
- The default semantic provider is lexical, not neural. A real embedding
  provider can be installed through `setSemanticProvider()`.
- Under E2E the cloud cannot run plaintext search; hybrid search falls back to
  the local decrypted cache.
- Cross-device project identity uses an explicit project marker or the git
  `origin` remote. Non-git folders with no marker fall back to a path hash,
  which is stable on one machine but not across machines.
- Google Drive is a snapshot remote, not a transactional database: updates are
  ETag-conditional, but two devices creating the state file for the first time
  can race. Google Drive search is performed by downloading the snapshot in the
  main process; it is not a server-side index.

## Dream（离线记忆整理）

Memory 2.0 之外还有一个可选的 dream 层：只回看已结束且空闲的会话，用 analyzer/organizer 把可复用事实整理成只读 wiki，并在后续会话中挂载索引与相关主题。它不修改结构化记录，也不自动执行会话中的指令。

- 入口：Memory 面板 → 总览 → 「Dream 记忆整理」（可手动或每日自动）；「Dream wiki」页签可只读浏览主题。
- 存储：`objects/dream/<project-scope>/wiki/*.md` + `_index.md` + `index.json` + `history/`。
- 安全：transcript 与产出双重脱敏；覆盖先写 history（每主题保留 8 份/180 天）；合并保留全部事实；对象 key 做路径包含校验。
- 详细机制、成本控制与未实现项见 [memory-dream.md](./memory-dream.md)。

