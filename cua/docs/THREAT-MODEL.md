# Threat model and safety boundaries

## Scope

This is a local, single-user runtime. It is not a hosted multi-tenant service.
The server binds `127.0.0.1` by default and requires a random bearer token. The
React console receives that token only from the locally served page. Do not bind
it to a public interface without adding authentication, TLS, per-user
authorization and tenant isolation.

## Assets and trust boundaries

- **Task owner**: the user/operator. The goal, authorization scope and acceptance
  criteria come from the user, not from the model.
- **Model**: untrusted with respect to authority. It can propose actions; it
  cannot edit authorization or acceptance. Its output is validated.
- **Page/file/tool content**: untrusted data. Prompt-injection text cannot grant
  permissions or change acceptance; the planner prompt says so and the executor
  does not derive permissions from content.
- **Browser/desktop environment**: isolated per task where possible. A browser
  session is not an OS sandbox; do not browse untrusted sites with credentials.
- **Code runtime**: separate process. macOS `sandbox-exec` denies network and
  writes outside a per-session scratch dir; Seatbelt also restricts file reads/process creation. Node permissions are additional protection. The VM exposes no `require/process/fetch` or raw CDP/Playwright.
- **SQLite/artifacts/token files**: local files with user-only permissions.

## Threats and mitigations

| Threat | Mitigation | Residual risk |
|---|---|---|
| Prompt injection in page | Treated as data; acceptance fixed; origin/tool scope enforced | A model may still be socially engineered into an allowed action; review authorization |
| Unauthorized origin/navigation | `allowedOrigins`; schema only http(s); executor checks before intent | `allowedOrigins` may be too broad if the user grants it |
| Stale element/coordinate | Generation/URL/scroll freshness checks; target refs scoped by generation; re-observe | A DOM can change without a navigation/generation bump; exact actionability still relies on the driver |
| False success | Programmatic task verification; fake toast rejected; `custom` never passes | Weak user criteria can still pass; criteria quality is the user's responsibility |
| Unknown write | Intent-first, `UNKNOWN` status, read-only recovery, no blind retry | The external system may not be observable; a human must reconcile |
| Duplicate submit | No automatic retry after unknown; action log dedup id is local only | The runtime does not claim exactly-once semantics |
| Code escapes | Separate process, sandbox-exec/bwrap where available, no host globals, UI RPCs through executor | macOS-only verified; Node permission model is defense in depth, not the sole boundary |
| Secret leakage | Event payload redaction; token files 0600; no API key in task/events; minimal child env | Page text/screenshot may contain secrets; user must not expose them to a model |
| Two agents writing one session | One controller per session, resource scheduler, DB lease/fencing, takeover waits for in-flight action | Multi-worker deployment is not fully tested |
| Monitor disturbing the screen | Monitor only reads events; no focus/action APIs | A separate user/process can still change the desktop |
| Reading/acting on the wrong app | Desktop observations are single-app by default: one window's screenshot + accessibility subtree, input refused outside it and only sent to a verified frontmost app | The app itself may show data from elsewhere; `scope: 'display'` (opt-in) reads the whole display |

## Explicit non-goals

- No exactly-once guarantee for arbitrary GUI actions.
- No guarantee that an action is reversible.
- No cloud multi-tenancy, billing isolation or public internet exposure.
- No universal OS support. Only macOS desktop and Chromium browser are verified.
- No download handling, closed-shadow-root traversal, or multi-display desktop
  coordinate support in this delivery.
- No claim of model capability parity from API shape alone. Capabilities are
  configured explicitly.


Current boundaries: Host/Origin validation guards the local console and bearer
injection; wildcard bind is opt-in and only loopback Host remains trusted.
Browser HTTP/WS routing is not a complete OS network firewall. Workflow deletion
is logical and does not erase SQLite old pages/backups. Structural recovery
state and screenshots may still contain private data; protect the data directory.
Desktop saving passed after user Automation consent. Native input and app-scripting save were tested on the host desktop with a dedicated fixture; this is not an isolated VM.
