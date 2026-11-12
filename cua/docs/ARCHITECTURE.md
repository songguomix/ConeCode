# Architecture

## Design stance

This runtime is a **single-user, local-first reference implementation**. It
keeps the orchestration, authorization, evidence and recovery in TypeScript and
puts the environment-specific bits behind explicit drivers. It uses public
APIs (Playwright, HTTP, SQLite via `node:sqlite`, macOS CGEvent) and does not
claim to reproduce any product's private implementation.

The central rule is:

> A returned action result is not a completed task. Observations and action
> results are evidence; acceptance is decided by a verifier reading the user's
> criteria.

## Components

| Component | Responsibility | Code |
|---|---|---|
| TaskController | Task state machine, budget/cancel/pause, loop, final acceptance | `src/agent/task-controller.ts` |
| ModelAdapter | Provider calls, tool calls, usage/capabilities/errors | `src/model/` |
| Planner | Builds model input from the latest observation and maps tool calls to validated actions | `src/agent/planner.ts` |
| Observer | Browser/desktop snapshot, target registry, screenshot metadata | `src/drivers/` |
| Executor | Authorization, freshness/actionability checks, intent-before-action, driver execution, postconditions | `src/agent/executor.ts` |
| Verifier | Programmatic conditions, task/recovery verification, evidence | `src/agent/verifier.ts` |
| RuntimeManager | Persistent code child, UI RPC bridge, timeout/termination | `src/runtime/` |
| BrowserDriver | Playwright Chromium session, tabs, snapshots, actions | `src/drivers/browser/` |
| MacDesktopDriver | One-app window observation (window screenshot + accessibility subtree), CGEvent helper, accessibility press/value, TextEdit scripting fallback | `src/drivers/desktop/` |
| SessionStore / EventLog | SQLite WAL, tasks/sessions/actions/observations/verifications/checkpoints/leases/workflows | `src/store/` |
| Coordinator | Queue, concurrency, resource serialization, leases | `src/service/runtime-service.ts` |
| Monitor | Read-only event consumer, repeated actions/failures/stalls | `src/agent/monitor.ts` |
| Console/SDK/CLI/MCP | Same service, different clients | `console/`, `src/sdk.ts`, `src/cli.ts`, `src/mcp-server.ts` |

## Runtime loop

```
created
  └─ observing ── capture observation (saved, generation recorded)
       └─ planning ── model proposes one tool call
            ├─ executing ── executor preflight + intent + driver action
            │    ├─ verifying_action ── action postconditions
            │    │    └─ observing
            │    ├─ verifying_unknown ── read-only reconciliation; no retry
            │    └─ needs_attention
            ├─ verifying ── independent task acceptance
            │    ├─ succeeded
            │    └─ failed / needs_attention
            ├─ awaiting_user ── question/approval; agent stops writing
            └─ paused / cancelled (not rollback; in-flight action noted)
```

Recovery uses `recovering` and `verifying_unknown`. A task can only move through
the transitions in `src/protocol/transitions.ts`; invalid jumps throw
`INVALID_TRANSITION`.

## Observation model

A browser observation contains:

- surface/tab id, URL/title, tab list, generation, viewport, scroll, DPR;
- visible text (bounded, with truncation flag);
- interactive targets with unique `targetId`, frame token, role, name, value,
  placeholder, checked/disabled, bounding box, `visible`/`actionable` and
  duplicate-key metadata;
- screenshot metadata: artifact, pixel size, viewport size, scale, crop
  offsets, scroll position;
- coverage: hidden/offscreen counts, unreadable frames/regions, truncation,
  shadow roots, open dialogs and explicit notes.

`targetId` is unique to an observation and frame token. A host ElementHandle registry prevents cloned diagnostic attributes from redirecting actions. It is not a permanent
element handle. Navigation invalidates the generation; scrolling invalidates
screenshot-coordinate actions. The executor checks live generation/URL/scroll
before every action and rejects stale observations before writing intent.

Open shadow roots are traversed. Iframes are observed and acted on through
Playwright frame handles. Closed shadow roots, unreadable frames and offscreen
content are reported as coverage gaps, not as "no content". Duplicate
role/name pairs are annotated with `duplicateKey`; the planner refuses to guess
which one was meant.

## Authorization and action flow

1. Planner output must resolve to a target in the current observation, or a
   screenshot coordinate with metadata. It cannot invent a target.
2. Executor checks task authorization (allowed origins, tools, desktop/code
   flags, file roots, expiry), observation freshness, target visibility and
   actionability.
3. The executor writes an `action.intent` event and an action row **before**
   calling the driver.
4. The driver performs the real action.
5. The executor records `action.result` (or `action.unknown`), plus evidence
   and action-level verification.
6. The controller re-observes; no success is inferred from the driver return.

A timeout or disconnect is classified as `unknown` for a write action, even if
the driver may have completed it. A read-only action that times out is a
`failed` action.

## Verification

`Verifier` supports `text_visible`, `text_absent`, `value_equals`,
`url_matches`, `record_field` (HTTP JSON), `file_content`, `file_exists`,
`window_title`, `http_status`, and `custom`. `custom` returns
`insufficient_evidence`; it is never treated as a pass. A failed condition is
`fail`; an unobservable condition is `insufficient_evidence`/`unknown`.

The controller runs the fixed user acceptance criteria at completion. Model
`suggestedChecks` are recorded and may strengthen acceptance, but can never
replace or weaken the user criteria. A model `finish` with a fake UI toast does
not pass if the durable record is unchanged.

## Concurrency and ownership

- One controller owns one session; writes are sequential inside a session.
- The service scheduler serializes tasks that share `session:*`, a
  `metadata.resourceKeys` entry, or `metadata.businessObject`, while allowing
  isolated sessions to run in parallel (`maxConcurrency`).
- SQLite `leases` store an owner, expiry and monotonically increasing fencing
  token. The single-process scheduler uses in-process resource locks; the lease
  is already acquired/released and is the hook for multi-worker fencing.
- Takeover waits for an in-flight action to settle before transferring
  ownership; if it cannot verify that, it refuses the transfer and leaves the
  action for reconciliation.
- The monitor only reads events. It never switches focus or writes to a
  surface; it appends `monitor.alert` events for duplicate actions, repeated
  verification failures and stalls.

## Persistent code runtime

`code.run` is a separate Node child process. On macOS it runs under
`sandbox-exec` with network and writes outside a per-session scratch directory
denied, plus Node's `--experimental-permission` filesystem restrictions. The VM
context exposes no `require`, `process`, `fetch` or raw CDP. Only the `ui`
object is available; each call is an RPC back to the executor, which builds a
normal `ActionProposal`, records intent/result, and performs the same freshness
and authorization checks as a model action.

Persistence rule: `globalThis`/`state` values survive between runs; local
`const`/`let` in one run do not. This is explicit in the tool prompt and docs.
A timeout kills the process group and reports whether the process was observed
to exit. If stop cannot be confirmed, the session is marked lost and never
reused; the next run starts fresh.

## Desktop channels

`MacDesktopDriver` has two explicitly separated channels:

1. **Raw GUI input** (click, move, drag, scroll, key, Unicode type) through a
   compiled Swift CGEvent helper. It is enabled only if
   `AXIsProcessTrusted`/CG event access is granted. After user authorization, native click, Unicode and shortcut effects were checked through a dedicated TextEdit fixture, including focus/window changes. An isolated guest is still unverified. Permission absence is `DRIVER_UNAVAILABLE`.
2. **App scripting fallback** (`desktop.edit_document`) that asks TextEdit to
   create a document, set its text and save to an authorized path. This is
   labelled as app scripting, not raw input. It has a file-content acceptance check and passed after the user allowed system Automation. Native input and app-scripting save are separate channels.

Observations are single-app by default: `scope: 'app'` captures exactly one
window (window-only screenshot with its screen origin and scale) plus that
window's accessibility subtree, and refuses input outside it. `scope: 'display'`
is the opt-in legacy whole-main-display capture, kept for debugging and without
structured targets. Screenshots report logical/pixel scale; multi-display
capture and window movement are not claimed as verified.

## Persistence and recovery

- SQLite is in WAL mode with `synchronous=FULL`; critical business writes are
  transactions. The event log is append-only with monotonic `seq`.
- Checkpoints store the model message history, step, finish attempts and last
  action result for inspection/recovery. The model conversation, browser handle
  and code process are treated as separate resources.
- On startup, pending action intents are marked `unknown`. Recovery creates a
  new browser/desktop session (never reuses an old handle), observes, runs the
  acceptance criteria read-only, and ends in `succeeded` only if acceptance is
  already true. Otherwise it ends in `needs_attention`; no write is retried.
- Historical event reads and the console are read-only; they never re-execute.

## Client surfaces

The React console, CLI, SDK and MCP adapter all talk to the same `RuntimeService`
through the HTTP API (or the service in the demo). The console receives the
random bearer token only from the locally bound server page; API requests use
that token. SSE is consumed with `fetch` so the token can be sent in a header.

## Current hardening and verification boundary

See DELIVERY.zh-CN.md and LIMITATIONS.md for the current measured support matrix.
HTTP verification permits only authorized GET/HEAD without redirects. Browser
HTTP/WS routing restricts origins and expiry and rejects all redirects; this is
not an OS firewall. Recovery reads record/file/http criteria without loading an
application; DOM recovery disables JavaScript, POST and WebSockets.

Model call budgets are reserved before each request; adapter retries default to
zero, and request metrics count errors without a response. Per-action failure
budgets use semantic targets scoped to page/surface/business object, so new refs
do not reset retry limits. Pauses keep the same loop/session. Timed-out host
promises block ownership transfer until they settle.

Code UI RPCs carry run IDs, serialize and drain even when user code omits await.
Timers are cleared between runs. OS sandbox tests exercise actual file/network
rejection without Node permission flags as the sole boundary. Workflow lifetime
is configurable, full memory data is pattern-redacted, and explicit deletion
removes only the named workflow. Event/evidence retention is not automated.
