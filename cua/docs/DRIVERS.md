# Driver guide

A driver is the only code that touches a real environment. It cannot decide that
a task is complete and it cannot bypass the executor.

## Interface

`src/drivers/types.ts`:

```ts
interface Driver {
  kind: 'browser' | 'desktop' | 'composite';
  start(): Promise<void>;
  close(): Promise<void>;
  surfaceId(): string;
  generation(): number;
  capabilities(): Capabilities;
  observe(): Promise<Observation>;
  execute(proposal: ActionProposal): Promise<DriverOutcome>;
  probe(condition: Condition, timeoutMs?: number): Promise<ProbeResult>;
  freshness(): Promise<{ surfaceId; generation; url?; scrollX?; scrollY? }>;
}
```

`DriverOutcome` contains `actual`, `evidence`, and optionally
`sideEffectUnknown`. Throwing is preferred over returning a fake success.
`probe` returns `pass|fail|insufficient_evidence|unknown`; drivers should not
invent evidence for areas they cannot read.

## Browser driver

`BrowserDriver` uses Playwright Chromium. Each task gets a browser context and
one or more pages. Browser sessions stay alive across model calls; the
observation/generation/tab ids are stable within that session.

### Snapshot and target refs

`src/drivers/browser/snapshot-injected.js` is plain JavaScript evaluated inside
each frame. It:

- traverses open shadow roots and interactive elements;
- assigns diagnostic `data-cua-ref` values unique to each observation/frame;
- collects role/name/value/placeholder/checked/disabled/bbox/attributes;
- flags duplicate role+name pairs;
- reports hidden/offscreen counts, shadow roots, open dialogs, truncation and
  unreadable regions.

Playwright frame handles cover iframes. Cross-origin/sandboxed frames that
cannot be evaluated are counted as unreadable, not empty. Closed shadow roots
cannot be traversed (documented limitation).

### Coordinates

Screenshots are viewport captures with `scale: 'css'`; pixel dimensions,
viewport, scroll, crop offset and device scale are stored in
`Observation.screenshot`. `screenshotToViewport` / `viewportToScreenshot` are
pure and unit-tested. Coordinate actions are rejected if the live scroll
position differs from the saved screenshot; a target action is always preferred.
The executor's freshness check also rejects generation/URL drift.

### Actionability

Before a target action the executor checks that the target is present, visible
and actionable. The driver registers exact ElementHandles in the trusted host during observation, checks connection and visibility, then uses Playwright actionability. Cloning the diagnostic attribute cannot redirect the handle. If the element was detached or a new observation generation
exists, the action is rejected; the controller re-observes.

### Tabs, dialogs and waits

`browser.open_tab/switch_tab/close_tab` are explicit. Native browser dialogs are
recorded and auto-dismissed to avoid hangs; this is surfaced in coverage notes.
`browser.wait_for` polls a programmatic condition and fails on timeout. The
controller does not assume a page is ready merely because an action returned.

## macOS desktop driver

The driver is **single-app by default** (`scope: 'app'`). Every observation reads
exactly one window of one app: a window-only screenshot plus that window's
accessibility subtree. Other applications, other windows of the same app and the
app menu bar are not read, and clicks outside that window are refused.

```ts
{ kind: 'desktop', scope: 'app' | 'display', appName?, bundleId?, windowTitle?, windowId? }
```

- `appName` (localised name, case-insensitive) or `bundleId` selects the app.
  Without either, the scope is the frontmost application's front window.
- `windowTitle` (substring) and `windowId` (CGWindowID) disambiguate windows.
- `scope: 'display'` keeps the legacy whole-main-display capture for debugging
  only; it is opt-in because it reads pixels of every app.

The Swift helper (`native/desktop-agent.swift`) is a JSON-lines process. It
reports:

- `AXIsProcessTrusted`, event access and screen-recording status;
- screens with logical size/scale;
- layer-0 windows (`windows`) with pid, bundle id, bundle name, title, frame and
  backing scale, front-to-back;
- window-only screenshots (`screenshot {windowId}`), `-o` so no shadow shifts
  coordinates, with the window's screen origin and scale;
- the accessibility tree of one app/window (`ax_tree {pid, bounds}`), pruned
  natively to the requested window;
- accessibility operations (`ax_press`, `ax_set_value`) and app/window focus
  (`activate {pid, bounds}`, which raises the matching window and verifies the
  app became frontmost).

Observation coordinates are **window-local image pixels**. The driver converts
them with the recorded scale, refuses points outside the captured window
(`AUTHORIZATION_DENIED`), then adds the window origin to post real input. Input
is only sent after the scoped app is verified frontmost; otherwise the action
fails without posting. If the window moves, resizes, is replaced or loses
focus between observation and action, freshness bumps the generation
(`TARGET_STALE`) and the model must observe again.

`desktop.press` and `desktop.set_value` prefer accessibility targets
(`targetId` → `ax:<path>`), so controls are operated without pointer movement;
`desktop.press` also accepts a screenshot point (AX hit-test).

Raw input uses CGEvent posts. **macOS silently discards synthetic input without
Accessibility/Input Monitoring permission**, so the helper checks permission and
verifies cursor movement; the driver returns `DRIVER_UNAVAILABLE` instead of
claiming success.

`desktop.edit_document` is a separate app-scripting channel restricted to
TextEdit and an authorized file root. It creates a new document, writes text
(including Unicode), saves to the exact path, and reads the file back. It is not
raw keyboard/mouse input and is labelled as such in capabilities/events.

Desktop limitations: main display only (window frames may sit on another
display but no multi-display capture is claimed), no verified window move/drag
gesture, accessibility coverage depends on what the app exposes (custom-drawn
canvases expose nothing), and `scope: 'display'` has no structured targets.

## Adding another driver

1. Implement `Driver` and return honest `capabilities()`/coverage notes.
2. Never read a target id/coordinate from a previous generation; use
   `freshness()` and let the executor's checks work.
3. Save screenshots through `ArtifactStore` and return their metadata.
4. Map driver errors to `CuaError`; set `sideEffectMayHaveHappened` only when
   the operation may have partially executed.
5. Implement `probe` only for conditions you can actually read; return
   `insufficient_evidence` otherwise.
6. Add a real integration test that asserts the environment result, not just
   that the driver method was called.
7. Add the driver to the support matrix only after that test passes on the
   actual target OS/environment.

Downloads are captured to ArtifactStore with source URL, filename and hash; the `download` condition independently rereads bytes. HTTP/WS origin and expiry checks are enforced, all redirects are rejected. Recovery mode disables JS/POST/WS. Screenshot dimensions come from viewport; there is no resampling setting.
