# Computer Use Agent runtime

## ConeCode desktop

Enable **Computer Use**, then choose an open window in the Computer Use panel. The
agent can also list app names and switch windows as the task requires, using the
current approval setting. Switching clears the preview; the next screenshot and
all pointer coordinates belong to the newly selected window. A moved or resized
window requires a fresh screenshot.

On macOS and Windows, the desktop controller captures the target window directly.
If capture or focus fails, it reports the error instead of using the desktop.
macOS supports clicking accessible controls and sending keys or text to the
selected window. Other pointer gestures are unavailable in this mode.
Windows input is restricted to actions the app accepts through window messages;
modified shortcuts, key holds, triple clicks, and drags are unavailable there.
Windows may require the user to bring the requested app forward if it denies
the focus change. Linux desktop Computer Use is unavailable. ConeCode’s
separate manual screenshot tool still supports user-selected screen regions.

## Standalone runtime

The standalone implementation lives in [`cua/`](../cua/README.md). It is a
local-first TypeScript/Playwright/macOS runtime with:

- task/observation/action/verification/event protocols and a SQLite WAL log;
- a real Chromium browser driver with structured targets + screenshots;
- a macOS desktop driver (native CGEvent Unicode/click/key input + TextEdit app-scripting save, verified after user authorization);
- independent task acceptance and conservative UNKNOWN/recovery handling;
- an isolated persistent code runtime with UI RPCs through the executor;
- a React console, CLI, typed SDK and stdio MCP server;
- deterministic tests and evaluation, plus an opt-in real-model test.

Quick start:

```bash
cd cua
npm ci
npm run install:browsers
npm run build:native   # macOS
npm test
npm run demo:browser
npm run demo:desktop -- --yes
npm run serve -- --open
```

Status, exact test evidence and external blockers:

- [Phase 0–12 record](../cua/docs/PHASES.md)
- [Limitations and support matrix](../cua/docs/LIMITATIONS.md)
- [Actual evidence](../cua/docs/EVIDENCE.md)

This package is independent of the existing Electron application code and does
not modify its runtime. Real-model inference is pending a provider credential;
desktop screenshot, native input and TextEdit save/read-back passed after user
authorization. The scope is a dedicated document on the host desktop, not an
isolated VM. See the current delivery report for precise boundaries.

- [Current delivery report](../cua/docs/DELIVERY.zh-CN.md)
- [Resume checkpoint](../cua/docs/CHECKPOINT.md)
