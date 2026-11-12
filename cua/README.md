# Computer Use Agent runtime (`cua/`)

A standalone, local-first Computer Use Agent implementation that observes a real
browser or desktop, proposes one action at a time, executes it through a guarded
tool path, records evidence, verifies the result programmatically, and recovers
conservatively when an outcome is unknown.

This is an original implementation built with public APIs. It does not contain
or reproduce any product's private source code. It lives inside the ConeCode
repository as a self-contained package so the existing Electron application is
not modified.

For the current audit, commands, and exact source fingerprint, see [delivery report](docs/DELIVERY.zh-CN.md) and [resume checkpoint](docs/CHECKPOINT.md). Historical evidence below is superseded by that report.

## What is actually verified here

| Area | Status |
|---|---|
| Real Playwright/Chromium browser tasks | Implemented and verified |
| Structured + screenshot observation, iframes, open shadow DOM, duplicate buttons, modal, tabs | Implemented and verified |
| Action-level and task-level verification, false-success rejection | Implemented and verified |
| SQLite event log, checkpoints, crash recovery, UNKNOWN reconciliation | Implemented and verified |
| Persistent code runtime with UI RPCs and macOS sandbox | Implemented and verified |
| macOS desktop | Single-app by default: one window screenshot + its accessibility subtree, AX press/value-write, native input, TextEdit save/file read-back verified in a dedicated host fixture |
| macOS raw mouse/keyboard | Native click (window-local), Unicode and shortcut verified; out-of-window points refused; focus/window changes tested; isolated guest and full gesture set pending |
| OpenAI-compatible model calls | Adapter implemented and HTTP-mock verified; **real-provider run pending a credential** |
| React console, CLI, typed SDK, MCP stdio server | Implemented and verified |
| Docker/Compose deployment | Provided, **not built** (Docker daemon was unavailable) |

See [docs/PHASES.md](docs/PHASES.md) for the phase-by-phase record and
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) for exact boundaries.

## Requirements

- Node.js 22.12+ (this run used v22.23.2)
- macOS for the native desktop driver / Swift helper
- Playwright Chromium (`npm run install:browsers`)
- No API key is needed for the deterministic demos and tests.

## Install and run

```bash
cd cua
npm ci
npm run install:browsers
npm run build:native       # macOS only; requires Xcode command-line tools
npm run build              # TypeScript + runtime assets + React console
npm test                   # deterministic suite
```

### Browser demo (real Chromium, deterministic planner)

```bash
npm run demo:browser
# Status: succeeded — All user acceptance criteria passed.
# Persisted project: {"id":1,"name":"Demo",...}
```

The demo starts a local fixture HTTP app, opens Chromium, fills the project
name, clicks Save, waits for the durable record, then independently reads
`/api/projects/1` before accepting the task.

### Desktop demo (macOS, TextEdit, explicit opt-in)

```bash
npm run demo:desktop
# equivalent to: node dist/cli.js demo desktop --yes
```

The task attempts a Unicode note save under `/tmp` through TextEdit and
acceptance reads the file. The initial attempt timed out on system Automation
authorization; after the user allowed it, the real save/read-back passed. Native
input uses the Swift helper; saving uses the explicit app-scripting channel. The demo requires `--yes` because it performs a real
local write.

### Console

```bash
npm run serve -- --open
# or: node dist/cli.js serve
```

The server prints its URL and a bearer-token path. Open `http://127.0.0.1:4317/`.
The React console shows tasks, status, latest screenshot, actions, verification,
live events, and pause/resume/cancel/takeover/release/recover controls.

### Deterministic evaluation

```bash
npm run eval
# Evaluation: 4/4 passed
# PASS baseline_form_save
# PASS save_failure_then_recover
# PASS fake_success_rejected
# PASS budget_exhaustion_is_terminal
```

This is a deterministic scripted controller evaluation, not a real-model
benchmark. Real-model results are reported separately and are not marked as
passed without a credential and an actual run.

## Real model

The planner uses function tools through an OpenAI-compatible Chat Completions
adapter. Capabilities are explicit configuration, not inferred from an API URL:

```bash
export OPENAI_API_KEY=...
cd cua
node dist/cli.js task create \
  --goal "Rename the local project to Demo and save it" \
  --url http://127.0.0.1:3000/ \
  --model "$CUA_REAL_MODEL" \
  --api-key-env OPENAI_API_KEY \
  --acceptance '[{"kind":"record_field","url":"http://127.0.0.1:3000/api/projects/1","path":["name"],"equals":"Demo"}]'
```

For image input, add `--images` and start the service/demo with
`CUA_SEND_SCREENSHOTS=1`; the provider must actually support image input. The
adapter never infers vision from the API URL.
The native `computer` tool of a specific provider is **not** used. The runtime's
own function tools are provider-neutral and always pass through the executor.
A real model call is pending in this delivery because no `OPENAI_API_KEY` was
available in the environment. The smoke and full browser-loop tests are opt-in:

```bash
CUA_RUN_REAL_MODEL=1 OPENAI_API_KEY=... CUA_REAL_MODEL=your-model npx vitest run test/model.test.ts test/evaluation.test.ts
```

The full real-model fixture evaluation is also available from the CLI:

```bash
export OPENAI_API_KEY=...   # credentials remain in the environment
export CUA_REAL_MODEL=your-model
npm run eval:real -- --json --max-model-calls 8 --max-cost-usd 0.5
```

A missing credential/model exits with code 2 and `status: not_run`. Provider or
task failure exits 1. This is one live baseline task, not a broad benchmark.
Choose capabilities explicitly. `max_completion_tokens` is the default;
`--token-parameter max_tokens` supports gateways requiring the older field.
Dollar accounting needs `--input-price` and `--output-price` in USD per million
tokens; without pricing, cost is `null` and call/token/time limits remain active.
Prices are estimates from configured rates, not provider billing receipts.

## Interfaces

### CLI

```bash
cua serve
cua task list
cua task show <taskId>
cua task events <taskId> --follow
cua task pause|resume|cancel|takeover|release|recover <taskId>
cua task input <taskId> --kind approval --text approve
cua demo browser
cua demo desktop --yes
# Desktop tasks read exactly one app window by default:
cua task create --goal "Summarise the open note" \
  --acceptance '[{"kind":"window_title","contains":"notes"}]' --app TextEdit
cua eval [--json]
cua eval --real --model MODEL [--json]
```

### Typed SDK

```ts
import { CuaClient } from './dist/sdk.js';

const client = new CuaClient({ baseUrl: 'http://127.0.0.1:4317', token: process.env.CUA_TOKEN });
const task = await client.createTask({ /* CreateTaskInput */ });
for await (const event of client.stream(task.id)) console.log(event.type, event.payload);
const details = await client.getTask(task.id);
```

### MCP

```bash
cd cua
CUA_API_URL=http://127.0.0.1:4317 CUA_TOKEN=... npm run mcp
```

MCP tools (stdio, versioned `schemaVersion: 1`): `cua_create_task`,
`cua_list_tasks`, `cua_get_task`, `cua_control_task`, `cua_submit_input`,
`cua_get_events`, `cua_metrics`, `cua_delete_workflow`. They call the same HTTP service used by the
console/CLI/SDK rather than a second execution path.

### HTTP

`GET /api/health`, `GET/POST /api/tasks`, `GET /api/tasks/:id`,
`GET /api/tasks/:id/events?stream=1`, `POST /api/tasks/:id/control`,
`POST /api/tasks/:id/input`, `GET /api/metrics`, `GET /api/workflows`,
`GET /api/artifacts/:id`. All API calls require the bearer token. The server
binds `127.0.0.1` by default.

## Architecture

```
TaskController
  ├─ Observer ── BrowserDriver / MacDesktopDriver
  ├─ Planner ─── ModelAdapter (scripted or OpenAI-compatible)
  ├─ Executor ── authorization, freshness, target checks, intent/result log
  ├─ Verifier ── programmatic conditions + independent task acceptance
  ├─ RuntimeManager ── persistent code runtime + UI RPCs + sandbox
  ├─ SessionStore / EventLog ── SQLite WAL + append-only events + checkpoints
  └─ Coordinator/Monitor ── queue, resource serialization, leases, alerts
```

The model never calls a browser API directly. Every action, including actions
inside `code.run` and actions requested through the console/MCP/CLI, goes
through the executor, where it is authorized and recorded before it happens.

Key files:

- `src/protocol/` — Zod schemas, IDs, error taxonomy, state transitions
- `src/agent/task-controller.ts` — observe → plan → execute → verify loop
- `src/agent/executor.ts` — preflight, intent-first execution, action evidence
- `src/agent/verifier.ts` — action/task/recovery verification
- `src/drivers/browser/` — Playwright driver, snapshot registry, coordinate math
- `src/drivers/desktop/` — one-app window observation (screenshot + accessibility subtree), CGEvent driver, AX press/value, TextEdit app-scripting channel
- `src/runtime/code-runtime.ts` — persistent child process under OS sandbox
- `src/store/` — SQLite store, leases, checkpoints, artifacts, workflows
- `src/service/` — runtime service + local HTTP/SSE server
- `console/` — React console; `src/mcp-server.ts`; `src/cli.ts`; `src/sdk.ts`

## Important safety behavior

- **Execution success ≠ task success.** The model can propose `finish`, but only
  the verifier reading user-owned acceptance criteria can set `succeeded`.
- Page/file/tool output is untrusted data; it cannot change the goal,
  authorization or acceptance criteria.
- Every write records an intent before execution. Timeouts/disconnects produce
  `UNKNOWN`; recovery performs a read-only check and never automatically retries
  the write.
- A session has one execution owner. The database has leases/fencing hooks for a
  future multi-worker deployment.
- Cancellation is not rollback. A paused/cancelled task reports any action that
  was still in flight and whether its effect is unknown.
- Code runs in a separate process under macOS `sandbox-exec` and Node's
  permission model, with no `require`/`process`/`fetch` in the VM. UI access is
  only through RPCs that go back through the executor.
- Desktop computer use reads one app window at a time (window screenshot plus
  that window's accessibility subtree), refuses input outside it, and only
  posts input after verifying the scoped app is frontmost. Whole-display
  observation is an explicit opt-in.

See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for the limits of those claims.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Protocol and API](docs/PROTOCOL.md)
- [Driver guide](docs/DRIVERS.md)
- [Recovery and UNKNOWN](docs/RECOVERY.md)
- [Testing and evaluation](docs/TESTING.md)
- [Phase 0–12 record](docs/PHASES.md)
- [Known limitations and support matrix](docs/LIMITATIONS.md)
- [Threat model](docs/THREAT-MODEL.md)
- [Actual evidence](docs/EVIDENCE.md)

## Reproduce the final checks

```bash
npm run verify:delivery
# macOS only; includes real desktop screenshot / focus / TextEdit save effects:
npm run verify:delivery -- --desktop
```

The verifier writes `artifacts/delivery/report.json`, per-command logs, JSON test
results and a SHA-256 source manifest. It fails if implementation/test inputs
change during the run. Real-provider inference is always a separate opt-in.
Default tests do not focus or type into your desktop. CI runs deterministic
checks with real Chromium and uploads evidence; Linux desktop is unsupported,
and code sandbox tests are skipped when their supported environment is absent.

The console is a local, single-user operator view. A loopback bearer token is
injected only after Host/Origin validation; wildcard binding is an explicit
container option. Keep Compose's host mapping at `127.0.0.1:4317:4317`.
Multi-worker service deployment is unsupported: store lease APIs are extension
points and do not enforce fencing at the GUI driver.

For a controlled before/after baseline, `RuntimeServiceConfig.observationMode` accepts `full | projected` (default projected). `npx tsx scripts/compare-controller.ts` runs paired real-browser scripted tasks with identical acceptance; it does not measure real-model inference.
