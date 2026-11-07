# ConeCode Memory 2.0 — cloud contract

This document describes the **vendor-neutral REST contract** implemented by
`server/memory-cloud/server.mjs` and consumed by
`src/core/memory/v2/storage/cloud.ts`. The Memory Engine never imports a
database or an object-storage SDK; a deployment only has to implement this
contract.

## Deployment layers

| Layer | Responsibility | Reference implementation |
| --- | --- | --- |
| Structured memory | records, relations, versions, change log, cursors, tenants, devices | `server/memory-cloud/server.mjs` (atomic JSON) |
| Google Drive | one-click OAuth, appDataFolder snapshot, ETag-conditional writes | `electron/memory-drive.ts` |
| Object storage | Markdown exports, attachments, backups (`/objects/*`) | the reference server keeps objects beside its JSON store |
| Client | local-first cache, SQLite-ready local provider, sync engine, UI | `src/core/memory/v2/` |

For production, put a PostgreSQL-backed gateway behind the same routes and keep
S3/R2/GCS for `/objects/*` and `/backup`. Do **not** store records or sync
cursors in object storage: it cannot provide the conditional writes, cursors and
conflict checks this contract needs. A reference schema is in
`server/memory-cloud/postgres-schema.sql`.

## Authentication and tenancy

Every request except `OPTIONS` requires:

```
Authorization: Bearer <MEMORY_CLOUD_TOKEN>
X-Tenant-Id: <tenant>        # [a-zA-Z0-9_-]{1,64}
X-Device-Id: <device uuid>
```

- The server compares the bearer token and refuses requests without it.
- `MEMORY_CLOUD_TENANTS=a,b` restricts which tenant ids a deployment accepts.
- Every tenant has an isolated record store. Search, changes, objects, usage,
  backups and device revocation never cross a tenant boundary.
- A revoked device receives `403` on every route.

TLS is required for non-loopback hosts. The client refuses plain HTTP unless
`tlsOnly` is disabled **and** the host is loopback. The reference server can
terminate TLS itself with `TLS_CERT` / `TLS_KEY`, or sit behind a reverse proxy.

## Routes

### `GET /health`

```json
{ "ok": true, "service": "conecode-memory-cloud", "version": 1, "tenant": "default" }
```

The client verifies `service`, so a random HTTP 200 is not treated as a valid
memory endpoint.

### `POST /search`

Request:

```json
{ "tenantId": "default", "query": { "text": "network timeout", "projectId": "proj-…", "scope": "all", "layers": ["project"], "limit": 20 } }
```

Response:

```json
{ "hits": [{ "record": { "…": "MemoryRecord" }, "score": 3.2, "matchedTerms": ["network"], "reasons": ["server full-text: network"] }] }
```

- Project isolation is enforced **on the server**: `scope=all` returns global
  rows plus rows for the requested `projectId`, never another project's rows.
- `scope=project` requires `projectId`; `scope=global` returns global rows only.
- E2E clients never call this route: the server holds ciphertext and cannot run
  plaintext full-text search. The client searches its locally decrypted cache.

### `GET /changes?since=<seq>&limit=<n>`

Returns the append-only change feed after a cursor. `cursor` is the server's
latest sequence, not merely the last returned item, so clients can advance past
an empty page safely.

### `POST /changes`

Request:

```json
{ "tenantId": "default", "deviceId": "…", "changes": [ { "seq": 1, "changeId": "ch-…", "memoryId": "…", "op": "create", "record": { "…": "MemoryRecord" }, "at": 0, "deviceId": "…", "projectId": "…" } ], "encrypted": false }
```

Response:

```json
{ "ok": true, "acceptedChangeIds": ["ch-…"], "cursor": 12, "conflicts": [] }
```

Rules:

- `changeId` is an idempotency key. Replaying it is accepted without writing a
  second change-log row.
- A record at the same version **and** content hash is accepted without a write.
- A record with an equal-or-newer version from another device and a different
  content hash is returned as a conflict (`local` = incoming, `remote` =
  current) and is **not** written. Both versions survive.
- Deletes are tombstones (`deletedAt`, `status=archived`), never hard deletes.

### Objects

- `PUT /objects/<key>` body `{ "content": "…" }`
- `GET /objects/<key>` returns `{ "content": "…" | null }`

Use this for Markdown exports, attachments and backup payloads, not for
transactional records.

### Devices and usage

- `GET /devices` → `{ "devices": [{ "deviceId": "…", "lastSeenAt": 0 }], "revoked": [] }`
- `POST /devices/revoke` body `{ "deviceId": "…" }`
- `GET /usage` → `{ records, changes, objects, bytes, devices }`

### Backup and restore

- `POST /backup` → `{ "ok": true, "key": "backup-<tenant>-<timestamp>.json" }`
- `POST /restore` restores the newest backup for the tenant.

### Tenant deletion

- `POST /tenant/delete` body `{ "confirm": "<tenant id>" }`

Destructive and irreversible: removes the tenant record file and its backups.
Local memory is not touched. The confirmation value must exactly equal the
tenant id so a stale client cannot wipe a namespace by accident.

## Google Drive provider (one-click OAuth)

Google Drive is a second provider, not a REST gateway. It stores one JSON
memory document in Drive's hidden `appDataFolder`; no files appear in “My
Drive”. OAuth runs in the Electron main process with a loopback redirect and
PKCE, and the refresh token/client secret are encrypted with `safeStorage`.

1. Create an OAuth client of type **Desktop app** in Google Cloud Console.
2. Add `http://127.0.0.1` as an allowed loopback redirect. If your client
   requires an exact port, set `GOOGLE_DRIVE_REDIRECT_PORT` and register
   `http://127.0.0.1:<port>/oauth2callback`.
3. Either set deployment environment variables:

```bash
GOOGLE_DRIVE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_DRIVE_CLIENT_SECRET=...
# optional exact loopback port
GOOGLE_DRIVE_REDIRECT_PORT=53682
```

or paste the client id/secret into **Memory → Cloud → Google Drive →
Advanced** once. After that, **Connect Google Drive** is one click.

The provider stores the structured record snapshot plus the change log in the
appDataFolder. Writes are ETag-conditional; concurrent edits are returned as
conflicts and handled by the same sync UI as the REST provider. Cloud-side
full-text search means “download the snapshot and search it locally in the main
process”; it is not a server-side index. Under E2E, Drive only holds ciphertext
and search falls back to the local decrypted cache.

Drive-specific limitations:

- Google Drive is a file API, not a transactional database. Two devices can
  still race on file creation; ETag protects updates, not the first create.
- Device revocation removes the device from the memory document but does not
  revoke the Google account grant. Use **Disconnect** or Google Account
  permissions to revoke the OAuth token.
- Drive quota is shown from Google's `storageQuota`; ConeCode does not manage
  Google billing or quota.

## Client configuration

The app's **Memory → Cloud** pane stores:

- server URL and bearer token (token encrypted at rest with Electron
  `safeStorage` when available),
- tenant id,
- auto-sync toggle and interval,
- encryption policy (`transport`, `server-at-rest`, `e2e`),
- client-side E2E passphrase (never transmitted),
- TLS-only enforcement.

There is no fake “connected” state. `health()` performs a real request and
reports the actual HTTP/DNS/TLS error.

## End-to-end encryption trade-off

`e2e` encrypts title/content/why/tags with AES-256-GCM (PBKDF2-SHA-256,
120k iterations) before upload. The server stores ciphertext only. Consequently:

- cloud-side full-text/semantic search is disabled;
- sync still works (records are decrypted after pull into the local cache);
- search always runs against the local decrypted cache;
- a new device must enter the same passphrase to read existing cloud memory.

The client must not claim server-side search while E2E is active; the UI shows
this limitation explicitly.

## Reference server

```bash
MEMORY_CLOUD_TOKEN=replace-me \
MEMORY_CLOUD_TENANTS=default \
MEMORY_CLOUD_DIR=./.memory-cloud-data \
PORT=8791 node server/memory-cloud/server.mjs
```

The reference server is deliberately dependency-free so it can be run and
tested without provisioning. It is not a multi-process database: deploy a
PostgreSQL-backed gateway implementing the routes above for production.
