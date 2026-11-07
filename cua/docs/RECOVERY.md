# Recovery and uncertain outcomes

## Why intent-first

Before any write, `Executor` commits an `action.intent` event and an action row.
If the process dies after that commit but before a result is recorded, the
database contains an action with status `intent` and no result. At startup the
service does **not** assume it failed. It marks it `unknown` with
`sideEffectUnknown: true`.

## Recovery procedure

`RuntimeService.recoverTask(taskId)`:

1. Loads the task; terminal tasks are left untouched.
2. Marks every pending action `unknown` (event `action.unknown`).
3. Marks old active/starting sessions `lost`; never reuses their handles.
4. Transitions the task to `recovering`.
5. Creates a **new** session identity. Record/file/HTTP acceptance is read without starting the application; conditions requiring a driver use a fresh browser with JavaScript/POST/WebSocket disabled, or desktop observation.
6. Runs the task's fixed acceptance criteria in read-only mode (`scope:
   recovery`) with a short wait.
7. If acceptance is already true, transitions to `succeeded` and records why.
   If it is false or cannot be proven, transitions to `needs_attention`.
8. Closes the recovery session and records the verification.

It never retries the write, never re-submits a form, and never reuses an old
browser/desktop handle. A human/operator decides whether to resume.

## What each state means

| State | Meaning |
|---|---|
| `executing` | An action was started; if the process died now, its outcome is unknown. |
| `verifying_action` | Driver returned; action postconditions are being checked. |
| `verifying_unknown` | An action may have happened; only read-only checks are allowed. |
| `recovering` | A new environment is being used to rediscover and verify state. |
| `needs_attention` | Acceptance could not be proven or the environment could not be inspected. Not success. |
| `cancelled` | Cancellation was requested. It is **not** rollback; check the action log for in-flight/unknown effects. |

## Test evidence

`test/recovery.test.ts` seeds an `executing` task with a pending click and then
starts a fresh service with `recoverOnStart: true`:

- persisted record already `Demo` → task `succeeded`, action `unknown`, no
  additional submit, data unchanged;
- persisted record still `Alpha` → task `needs_attention`, action `unknown`,
  data unchanged;
- old session `lost`, new session id, old handle not reused.

This covers “submit happened but response was lost”, “intent recorded then
process exited”, and “browser handle lost”. Historical event reads never
re-execute writes; the console/SDK are read-only for history.

## Multi-process ownership

The `leases` table stores `session_id`, `owner_id`, `fencing_token` and
`expires_at`. A second live owner is rejected; renewal requires the matching
owner and fencing token. The current deployment is single-process and uses
in-process resource locks plus this lease as the future multi-worker hook.


## Actual process termination and startup effects

`test/process-crash.test.ts` forks a separate runtime, stops at recorded intent
or after the real browser save commits but before its driver result returns,
and sends SIGKILL. Fresh service recovery verifies the durable record and never
replays the click. This complements the seeded database tests above.

`test/recovery-readonly.test.ts` proves record recovery does not load an
application startup page that can submit again. Browser tests separately prove
DOM recovery mode prevents startup JavaScript/POST/WS. A SPA requiring scripts
may yield insufficient evidence; the runtime does not enable writes to make
recovery pass. GET endpoints must themselves obey read-only business semantics.
