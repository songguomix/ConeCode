# Protocol and API

All protocol entities carry `schemaVersion: 1` and are validated with Zod at
runtime. The canonical definitions are in `src/protocol/schemas.ts`.

## Correlation IDs

| Prefix | Entity |
|---|---|
| `task_` | Task |
| `run_` | Run |
| `ses_` | Session |
| `obs_` | Observation |
| `act_` | ActionProposal / execution |
| `ver_` | VerificationResult |
| `evt_` | Event |
| `art_` | Artifact |
| `ckpt_` | Checkpoint |
| `wf_` | Workflow memory |

A task also stores `runId` and `sessionId`; actions link
`taskId/runId/sessionId/observationId`; events carry the same correlation fields
plus optional `correlationId`. `surfaceId`, `frameId` and business object keys
are carried where relevant.

## Task

```ts
{
  schemaVersion: 1,
  id, runId,
  goal, constraints,
  acceptance: Condition[],       // user-owned; at least one
  acceptanceSource: 'user'|'template'|'operator',
  authorization: {
    allowedOrigins, allowedTools, allowDesktop, allowCode,
    allowedFileRoots, allowedRecipients, expiresAt?
  },
  budgets: {
    maxSteps, maxModelCalls, maxCodeRuns, maxRetriesPerAction,
    maxWallClockMs, maxCostUsd, maxInputTokens, maxOutputTokens
  },
  environment: BrowserEnvironment | DesktopEnvironment,
  // DesktopEnvironment: { scope: 'app'|'display', appName?, bundleId?,
  //                       windowTitle?, windowId?, workdir? }
  // 'app' (default) reads exactly one app window; 'display' is opt-in.
  status: TaskStatus,
  statusReason?, createdAt, updatedAt, version,
  sessionId?, lastObservationId?, terminalReason?,
  metadata: Record<string, unknown>
}
```

`CreateTaskInput` additionally accepts a model block
(`provider/model/baseUrl/apiKeyEnv/capabilities/pricing`), an optional
deterministic `script`, and `metadata`. A real OpenAI-compatible provider is
accepted only when its key environment variable is present.

## Conditions

- `text_visible {text, scope, withinMs?}`
- `text_absent {text, withinMs?}`
- `value_equals {targetId, value, withinMs?}`
- `url_matches {pattern, withinMs?}`
- `record_field {url, method, path[], equals, headers?, withinMs?}`
- `file_content {path, contains?, equals?, withinMs?}`
- `file_exists {path}`
- `window_title {contains}`
- `http_status {url, method, status, headers?, body?}`
- `download {filename, sha256?, contains?, withinMs?}` — rereads a persisted download artifact
- `custom {description}` — always `insufficient_evidence`, never a success

URLs in conditions/actions are restricted to `http(s)` by schema.

## Task status and transitions

Statuses: `created`, `observing`, `planning`, `executing`, `verifying_action`,
`verifying`, `verifying_unknown`, `recovering`, `awaiting_user`, `paused`,
`succeeded`, `failed`, `cancelled`, `needs_attention`.

- Terminal: `succeeded`, `failed`, `cancelled`.
- `awaiting_user`, `paused`, `needs_attention` are resumable/attention states,
  not silently successful states.
- `verifying_unknown` means an action has an unknown effect and read-only
  reconciliation is required.
- The complete allowed-transition table is in
  `src/protocol/transitions.ts`. `succeeded` cannot transition back to running.

## ActionProposal / ExecutionResult

Actions are a discriminated union on `tool`:

- `browser.navigate/open_tab/switch_tab/close_tab`
- `browser.click/fill/type/press/scroll/hover/drag/wait_for/screenshot/observe`
- `desktop.click/move/drag/type/key/scroll/screenshot/press/set_value/focus_app/open_app/edit_document`
- `code.run`
- `task.finish` (handled by the controller/verifier, never the executor driver)

A proposal records the observation/generation/surface, resolved target ref,
expected conditions, risk, approval flag and rationale.

`ExecutionResult` records `status` (`succeeded|failed|unknown|partial|cancelled`),
`returned`, `sideEffectUnknown`, actual driver result, stable error
code/message/retryable, and evidence references. `status: succeeded` means the
driver returned and any declared postcondition passed; it does not mean the
whole task is complete.

## VerificationResult

Contains `scope` (`action|task|recovery`), criteria, per-criterion verdicts,
overall `pass|fail|insufficient_evidence|unknown`, evidence refs, missing
information, verifier name and timestamp. `insufficient_evidence` and `unknown`
are never converted to `pass`.

## Events

Event types include task/session lifecycle, observations, action intent/result/
unknown/reconciled, verification, model request/response/error, code lifecycle,
monitor alerts, user input/takeover/release, lease, artifacts and workflow
learning/invalidation. Every event has a monotonically increasing `seq`, an
`evt_` id, timestamp, actor, correlation IDs and a redacted payload.

Sensitive keys (password/secret/token/API key/authorization/cookie/session id/
credential/private key, including camelCase variants) are redacted from event
payloads; structural task/action state needed for recovery is stored intact.
The API exposes the redacted event log; artifacts require the bearer token.

## Errors

`CuaError` has a stable code, message, `retryable`, optional details and
`sideEffectMayHaveHappened`. Codes include protocol/transition/budget/
authorization/target/stale/driver/model/verification/unknown/lease/code/limit/
conflict/internal. HTTP responses use:

```json
{ "error": { "code": "...", "message": "...", "retryable": false,
             "sideEffectMayHaveHappened": false, "details": {} } }
```

## HTTP API

Local server defaults to `127.0.0.1:4317`. All `/api/*` routes except the public health endpoint require
`Authorization: Bearer <server-token>`; the token file is `0600`.

| Method/path | Purpose |
|---|---|
| `GET /api/health` | version, platform, drivers, auth mode |
| `GET /api/tasks?limit=` | task summaries + latest observation |
| `POST /api/tasks` | create task (validated `CreateTaskInput`) |
| `GET /api/tasks/:id` | task, session, observation, actions, verifications, events, live flags |
| `GET /api/tasks/:id/events?since=&stream=1` | historical events or SSE |
| `POST /api/tasks/:id/control` | `pause|resume|cancel|takeover|release|recover` |
| `POST /api/tasks/:id/input` | `{kind:'approval'|'answer'|'freeform', text}` |
| `GET /api/events?since=&stream=1` | global event history/stream |
| `GET /api/metrics` | run counts and evidence-based metrics |
| `GET /api/artifacts/:id` | screenshot/file artifact bytes |
| `GET /api/workflows` | verified workflow memory |
| `DELETE /api/workflows/:encodedName` | logical deletion of exactly one workflow |
| `POST /api/tasks/:id/workflow/invalidate` | expire a learned workflow |

SSE frames use `id: <seq>` and a JSON `data:` body. The SDK sends the bearer
token in the request header and cancels the reader on exit.

## MCP

The stdio MCP server exposes `cua_create_task`, `cua_list_tasks`,
`cua_get_task`, `cua_control_task`, `cua_submit_input`, `cua_get_events`,
`cua_metrics`, `cua_delete_workflow`. Inputs accept `schemaVersion: 1`; outputs are JSON with
`schemaVersion: 1`. The adapter is an HTTP client of the same service; it does
not execute actions locally.

## SDK

`CuaClient` provides typed `health`, `metrics`, `listTasks`, `createTask`,
`getTask`, `control`, `submitInput`, `events`, `stream`, `artifactUrl` and
`waitForTask`. See `src/sdk.ts`.

HTTP condition execution is read-only GET/HEAD with authorized origins and no redirects; legacy POST fields are rejected by the verifier. SSE resumes from `since` or `Last-Event-ID`, validates schemaVersion, and observes backpressure. SDK exposes `listWorkflows` and `deleteWorkflow`. `CUA_WORKFLOW_MAX_AGE_MS` / service `workflowMaxAgeMs` configures memory lifetime (default seven days).
