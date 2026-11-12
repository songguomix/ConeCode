import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { newId } from '../../protocol/ids.js';
import { CuaError } from '../../protocol/errors.js';
import {
  DesktopActionSchema,
  ObservationSchema,
  nowIso,
  type ActionProposal,
  type Capabilities,
  type Condition,
  type DesktopAction,
  type Environment,
  type EvidenceRef,
  type Observation,
  type ScreenshotMeta,
} from '../../protocol/schemas.js';
import type { ArtifactStore } from '../../store/artifacts.js';
import type { Driver, DriverContext, DriverOutcome, ProbeResult } from '../types.js';
import { unsupportedProbe } from '../types.js';
import { pngDimensions, screenshotToViewport } from '../browser/coordinates.js';
import {
  appWindowSurfaceId,
  axNodesToTargets,
  describePoint,
  describeWindow,
  globalToWindowLocal,
  isPointInsideWindow,
  pruneAxTreeToWindow,
  selectAppWindow,
  WINDOW_POINT_TOLERANCE,
  windowBoundsKey,
  windowLocalToGlobal,
  type AxNode,
  type WindowBounds,
  type WindowInfo,
  type WindowScope,
} from './app-scope.js';
import { parseMacKeyCombo } from './macos-keys.js';

const execFileAsync = promisify(execFile);

interface HelperStatus {
  platform: string;
  accessibility: boolean;
  eventAccess: boolean;
  screenRecording: boolean;
  screens: Array<{ displayId: string; x: number; y: number; width: number; height: number; scale: number; name?: string }>;
  frontmost: { appName?: string; bundleId?: string; pid?: number; windowTitle?: string; windowId?: number };
  macOS: string;
}

class HelperClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = '';
  private stderr = '';

  constructor(private readonly helperPath: string) {}

  async start(): Promise<void> {
    await stat(this.helperPath).catch(() => {
      throw new CuaError('DRIVER_UNAVAILABLE', `Native desktop helper not found at ${this.helperPath}. Run npm run build:native.`);
    });
    this.child = spawn(this.helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME ?? tmpdir(),
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        LANG: process.env.LANG ?? 'en_US.UTF-8',
      },
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8_000);
    });
    this.child.on('exit', (code, signal) => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Desktop helper exited (code=${code}, signal=${signal}). ${this.stderr.slice(-1_000)}`));
        this.pending.delete(id);
      }
    });
    this.child.on('error', (error) => {
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new HelperError(message.code ?? 'DRIVER', message.error ?? 'desktop helper error'));
    }
  }

  call(op: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
    if (!this.child || !this.child.stdin.writable) return Promise.reject(new Error('Desktop helper is not running.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Desktop helper timed out after ${timeoutMs}ms for op ${op}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
    });
  }

  async close(): Promise<void> {
    if (!this.child) return;
    try {
      // Closing a read-only observer must not post input to the user's desktop.
    } finally {
      this.child.stdin.end();
      this.child.kill();
      this.child = undefined;
    }
  }
}

class HelperError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'HelperError';
  }
}

const TEXTEDIT_SCRIPT = `
on run argv
  set contentText to item 1 of argv
  set savePath to item 2 of argv
  tell application "TextEdit"
    activate
    set newDoc to make new document
    set text of newDoc to contentText
    save newDoc in POSIX file savePath
    close newDoc saving no
  end tell
  return savePath
end run
`;

/**
 * macOS desktop driver. Mouse/keyboard actions are real CGEvent posts through a
 * compiled Swift helper; they are reported as unavailable when macOS withholds
 * Accessibility/Input Monitoring. TextEdit document editing is a separate,
 * explicitly labelled app-scripting channel that does not rely on synthetic
 * input; it is still authorized and logged by the same executor.
 */
export class MacDesktopDriver implements Driver {
  readonly kind = 'desktop' as const;
  private readonly helper: HelperClient;
  private statusCache?: HelperStatus;
  private started = false;
  private generationCounter = 0;
  private surface = 'desktop_scope';
  private observedEnvironment?: string;
  private target?: WindowInfo;
  private observedWindow?: WindowInfo;
  private lastObservation?: Observation;

  constructor(
    private readonly ctx: DriverContext,
    private readonly environment: Extract<Environment, { kind: 'desktop' }>,
    private readonly artifacts: ArtifactStore,
    private readonly options: { helperPath?: string } = {},
  ) {
    this.helper = new HelperClient(options.helperPath ?? join(process.cwd(), 'native', 'bin', 'desktop-agent'));
    if (!this.appScoped) this.surface = 'desktop_main';
  }

  /** Single-app observation is the default; whole-display capture is opt-in. */
  private get appScoped(): boolean {
    return (this.environment.scope ?? 'app') === 'app';
  }

  private get windowScope(): WindowScope {
    return {
      appName: this.environment.appName,
      bundleId: this.environment.bundleId,
      windowTitle: this.environment.windowTitle,
      windowId: this.environment.windowId,
    };
  }

  async start(): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new CuaError('DRIVER_UNAVAILABLE', `Native desktop driver is implemented and verified for macOS only; current platform is ${process.platform}.`);
    }
    await this.helper.start();
    this.statusCache = await this.helper.call('status');
    this.started = true;
  }

  async close(): Promise<void> {
    await this.helper.close();
    this.started = false;
  }

  capabilities(): Capabilities {
    const status = this.statusCache;
    const input = status?.eventAccess === true;
    const scoped = this.appScoped;
    const scopeLabel = this.environment.appName ?? this.environment.bundleId ?? this.environment.windowTitle ?? 'the frontmost app window';
    return {
      observe: status?.screenRecording === true,
      screenshot: status?.screenRecording === true,
      click: input,
      type: input,
      unicodeType: input,
      scroll: input,
      drag: input,
      key: input,
      tabs: false,
      code: true,
      actions: [
        'desktop.click', 'desktop.move', 'desktop.drag', 'desktop.type', 'desktop.key',
        'desktop.scroll', 'desktop.screenshot', 'desktop.press', 'desktop.set_value',
        'desktop.focus_app', 'desktop.open_app',
        'desktop.edit_document', 'code.run', 'task.finish',
      ],
      notes: [
        'Mouse/keyboard input requires macOS Accessibility/Input Monitoring permission; without it actions fail explicitly, they do not report false success.',
        scoped
          ? `Observations are scoped to one window of ${scopeLabel}: the window screenshot plus that window's accessibility subtree. Other apps and windows are not read, and clicks outside the window are refused.`
          : 'Display scope is opt-in: screenshots cover the main display only and multi-display coordinates are not claimed to be supported.',
        scoped
          ? 'Screenshot coordinates are window-local image pixels; the driver converts them into screen points for the scoped window.'
          : 'Screenshot coordinates are main-display image pixels in this opt-in display scope.',
        'Prefer desktop.press/desktop.set_value with a target id from the latest observation over guessing coordinates.',
        'TextEdit edit_document is app scripting, not raw GUI input.',
        ...(input ? [] : ['Current process is NOT trusted for accessibility/event posting.']),
      ],
    };
  }

  surfaceId(): string {
    return this.surface;
  }

  generation(): number {
    return this.generationCounter;
  }

  async freshness(): Promise<{ surfaceId: string; generation: number; url?: string; scrollX?: number; scrollY?: number }> {
    let identity: string;
    try {
      identity = await this.observationIdentity();
    } catch {
      identity = 'unresolvable';
    }
    if (this.observedEnvironment !== undefined && identity !== this.observedEnvironment) this.generationCounter += 1;
    this.observedEnvironment = identity;
    return { surfaceId: this.surface, generation: this.generationCounter };
  }

  /** Identity of what an action would touch: the one window, not the whole desktop. */
  private async observationIdentity(): Promise<string> {
    const status = await this.status();
    if (!this.appScoped) return JSON.stringify({ screens: status.screens, frontmost: status.frontmost });
    const window = await this.resolveWindow();
    return JSON.stringify({
      frontmost: status.frontmost,
      window: {
        windowId: window.windowId,
        bounds: window.bounds,
        title: window.title,
        appName: window.appName,
        bundleId: window.bundleId,
        pid: window.pid,
      },
    });
  }

  async status(): Promise<HelperStatus> {
    if (!this.started) throw new CuaError('DRIVER_UNAVAILABLE', 'Desktop driver is not started.');
    const status = (await this.helper.call('status')) as HelperStatus;
    this.statusCache = status;
    return status;
  }

  /**
   * Resolve the one window this driver is allowed to read and operate.
   * Without an explicit app, the scope is the frontmost application, never
   * "whatever window is on top of the display".
   */
  private async resolveWindow(scope: WindowScope = this.windowScope): Promise<WindowInfo> {
    if (!this.started) throw new CuaError('DRIVER_UNAVAILABLE', 'Desktop driver is not started.');
    const listing = await this.helper.call('windows', {
      appName: this.environment.appName,
      bundleId: this.environment.bundleId,
    });
    let windows = (Array.isArray(listing?.windows) ? listing.windows : []) as WindowInfo[];
    if (!scope.appName && !scope.bundleId && scope.windowId === undefined) {
      const status = this.statusCache ?? (await this.status());
      const pid = status.frontmost?.pid;
      if (pid) windows = windows.filter((window) => window.pid === pid);
    }
    const selected = selectAppWindow(windows, scope);
    this.target = selected;
    return selected;
  }

  /** Bring the scoped app and window forward so scoped input reaches it. */
  private async activateWindow(window: WindowInfo): Promise<WindowInfo> {
    const activation = await this.helper.call('activate', { pid: window.pid, bounds: window.bounds });
    if (activation?.frontmost !== true) {
      throw new CuaError(
        'DRIVER_UNAVAILABLE',
        `Could not bring ${describeWindow(window)} to the front; no input was sent.`,
        { retryable: false },
      );
    }
    const live = await this.resolveWindow({ windowId: window.windowId });
    return live;
  }

  async capture(window?: WindowInfo): Promise<{ meta: ScreenshotMeta; status: HelperStatus; window?: WindowInfo }> {
    if (!this.started) throw new CuaError('DRIVER_UNAVAILABLE', 'Desktop driver is not started.');
    const permissions = await this.status();
    if (!permissions.screenRecording) throw new CuaError('DRIVER_UNAVAILABLE', 'Screen Recording permission is missing; no desktop screenshot was captured.');
    const target = this.appScoped ? window ?? (await this.resolveWindow()) : undefined;
    const temp = join(tmpdir(), `cua-desktop-${randomUUID()}.png`);
    try {
      const result = await this.helper.call('screenshot', target ? { path: temp, windowId: target.windowId } : { path: temp });
      const status = (await this.helper.call('status')) as HelperStatus;
      this.statusCache = status;
      const bytes = await readFile(temp);
      const originX = typeof result.origin?.x === 'number' ? result.origin.x : target?.bounds.x ?? 0;
      const originY = typeof result.origin?.y === 'number' ? result.origin.y : target?.bounds.y ?? 0;
      const artifact = await this.artifacts.save({
        taskId: this.ctx.taskId,
        kind: 'desktop-screenshot',
        bytes,
        extension: '.png',
        meta: {
          sessionId: this.ctx.sessionId,
          display: result.screenRecording,
          windowId: target?.windowId,
          appName: target?.appName,
        },
      });
      const dims = pngDimensions(bytes);
      const meta: ScreenshotMeta = {
        artifactId: artifact.id,
        path: artifact.path,
        width: dims.width,
        height: dims.height,
        viewportWidth: Math.max(1, result.logicalWidth),
        viewportHeight: Math.max(1, result.logicalHeight),
        scaleX: result.scaleX,
        scaleY: result.scaleY,
        scrollX: 0,
        scrollY: 0,
        // A window capture is not cropped: image pixel 0,0 is the window's
        // own top-left. The window's screen origin is recorded separately on
        // the observation interface so coordinates stay unambiguous.
        offsetX: 0,
        offsetY: 0,
        devicePixelRatio: result.scale,
        fullPage: false,
      };
      const captured = target
        ? {
            ...target,
            bounds: {
              x: originX,
              y: originY,
              width: meta.viewportWidth,
              height: meta.viewportHeight,
            },
          }
        : undefined;
      return { meta, status, window: captured };
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  async observe(): Promise<Observation> {
    if (!this.appScoped) return this.observeDisplay();
    const status = await this.status();
    if (!status.screenRecording) {
      throw new CuaError('DRIVER_UNAVAILABLE', 'Screen Recording permission is missing; no app window was observed.');
    }
    const selected = await this.resolveWindow();
    const { meta, window: captured } = await this.capture(selected);
    const window = captured ?? selected;
    this.observedWindow = window;
    this.target = window;
    this.surface = appWindowSurfaceId(window);
    this.generationCounter += 1;
    this.observedEnvironment = JSON.stringify({
      frontmost: status.frontmost,
      window: {
        windowId: window.windowId,
        bounds: window.bounds,
        title: window.title,
        appName: window.appName,
        bundleId: window.bundleId,
        pid: window.pid,
      },
    });

    let nodes: AxNode[] = [];
    let axTruncated = false;
    let axWindowMatched = true;
    let axError: string | undefined;
    if (status.accessibility) {
      try {
        const tree = await this.helper.call('ax_tree', {
          pid: window.pid,
          maxDepth: 10,
          maxNodes: 320,
          bounds: window.bounds,
        });
        const rawNodes = (Array.isArray(tree?.nodes) ? tree.nodes : []) as AxNode[];
        axTruncated = tree?.truncated === true;
        const pruned = pruneAxTreeToWindow(rawNodes, window.bounds);
        axWindowMatched = pruned.matched;
        nodes = pruned.nodes;
      } catch (error) {
        axError = error instanceof Error ? error.message : String(error);
      }
    }
    const converted = axNodesToTargets(nodes, window.bounds);
    const notes = [
      `Observation is scoped to one window of ${window.appName}${window.bundleId ? ` (${window.bundleId})` : ''}; other applications and windows were not read.`,
      'The screenshot and every target coordinate belong to this window; absence outside it is not evidence.',
      status.accessibility
        ? axWindowMatched
          ? "Targets are this window's accessibility subtree, in window-local points."
          : 'The accessibility window frame did not match the captured window; targets were limited by window bounds only.'
        : 'Accessibility permission is missing, so only the window screenshot is available.',
      ...(axError ? [`Accessibility tree read failed: ${axError}`] : []),
      ...(status.eventAccess
        ? []
        : ['Accessibility/Input Monitoring is not granted; pointer, keyboard and text input are unavailable until the user grants it and restarts the driver.']),
    ];
    const observation = ObservationSchema.parse({
      schemaVersion: 1,
      id: newId('obs'),
      taskId: this.ctx.taskId,
      runId: this.ctx.runId,
      sessionId: this.ctx.sessionId,
      surfaceId: this.surface,
      generation: this.generationCounter,
      at: nowIso(),
      interface: {
        kind: 'desktop',
        appName: window.appName,
        windowTitle: window.title,
        bundleId: window.bundleId,
        windowId: window.windowId,
        windowBounds: {
          x: window.bounds.x,
          y: window.bounds.y,
          width: window.bounds.width,
          height: window.bounds.height,
        },
        displayId: status.screens[0]?.displayId ?? '0',
      },
      screenshot: meta,
      visibleText: [`${window.appName}${window.title ? ` — ${window.title}` : ''}`, converted.text]
        .filter(Boolean)
        .join('\n'),
      targets: converted.targets,
      frames: [],
      coverage: {
        textTruncated: converted.textTruncated || axTruncated,
        targetsTruncated: converted.truncated,
        hiddenTargets: converted.omitted,
        offscreenTargets: 0,
        crossOriginFrames: 0,
        shadowRoots: 0,
        openDialogs: 0,
        coverageNotes: notes,
        unreadableRegions: status.accessibility
          ? axWindowMatched
            ? []
            : ['Controls outside the scoped window frame were not mapped to targets.']
          : ['Accessibility controls are unavailable without Accessibility permission.'],
      },
      redactions: [],
    });
    this.lastObservation = observation;
    return observation;
  }

  /** Legacy whole-display path, reachable only with `scope: 'display'`. */
  private async observeDisplay(): Promise<Observation> {
    const { meta, status } = await this.capture();
    this.observedEnvironment = JSON.stringify({ screens: status.screens, frontmost: status.frontmost });
    this.generationCounter += 1;
    const front = status.frontmost;
    const notes = [
      'Desktop observations are visual: the display was captured, so pixels outside the task app were read as well.',
      'A screenshot covers the main display; absence outside it is not evidence.',
      ...(status.eventAccess
        ? []
        : ['Accessibility/Input Monitoring is not granted; pointer, keyboard and text input are unavailable until the user grants it and restarts the driver.']),
    ];
    const observation = ObservationSchema.parse({
      schemaVersion: 1,
      id: newId('obs'),
      taskId: this.ctx.taskId,
      runId: this.ctx.runId,
      sessionId: this.ctx.sessionId,
      surfaceId: this.surface,
      generation: this.generationCounter,
      at: nowIso(),
      interface: {
        kind: 'desktop',
        appName: front?.appName,
        windowTitle: front?.windowTitle,
        displayId: status.screens[0]?.displayId ?? '0',
      },
      screenshot: meta,
      visibleText: [front?.appName, front?.windowTitle].filter(Boolean).join(' — '),
      targets: [],
      frames: [],
      coverage: {
        textTruncated: false,
        targetsTruncated: false,
        hiddenTargets: 0,
        offscreenTargets: 0,
        crossOriginFrames: 0,
        shadowRoots: 0,
        openDialogs: 0,
        coverageNotes: notes,
        unreadableRegions: ['Desktop controls are not exposed as structured targets in this driver.'],
      },
      redactions: [],
    });
    this.lastObservation = observation;
    return observation;
  }

  async execute(proposal: ActionProposal): Promise<DriverOutcome> {
    const action = DesktopActionSchema.parse(proposal.action) as DesktopAction;
    const evidence: EvidenceRef[] = [];
    const actual: Record<string, unknown> = {};
    try {
      switch (action.tool) {
        case 'desktop.screenshot': {
          const { meta } = await this.capture();
          this.generationCounter += 1;
          actual.screenshot = meta;
          evidence.push({ kind: 'screenshot', ref: meta.artifactId ?? meta.path });
          return { actual, evidence };
        }
        case 'desktop.press': {
          const { observation } = proposal as ActionProposal & { observation?: Observation };
          const target = this.appScoped ? await this.requireScopedWindow('desktop.press') : await this.resolveWindow();
          let path = '';
          if (action.targetId !== undefined) {
            const observedTarget = this.lastObservation?.targets.find((item) => item.targetId === action.targetId);
            path = observedTarget?.attributes?.axPath ?? '';
            if (!path) {
              throw new CuaError(
                'TARGET_NOT_FOUND',
                `Target ${action.targetId} is not an accessibility target from the latest window observation; observe the app window again.`,
              );
            }
          }
          let global: { x: number; y: number } | undefined;
          if (action.x !== undefined && action.y !== undefined) {
            if (this.appScoped) {
              const local = this.toWindowPoint(action.x, action.y, observation ?? this.lastObservation, target.bounds, 'desktop.press');
              global = windowLocalToGlobal(local, target.bounds);
            } else {
              const meta = (observation ?? this.lastObservation)?.screenshot;
              global = meta ? screenshotToViewport([action.x, action.y], meta) : { x: action.x, y: action.y };
            }
          }
          const result = await this.helper.call('ax_press', {
            pid: target.pid,
            ...(path ? { path } : {}),
            ...(global ? { x: global.x, y: global.y } : {}),
          });
          actual.press = result;
          actual.appName = target.appName;
          actual.windowId = target.windowId;
          this.generationCounter += 1;
          return { actual, evidence };
        }
        case 'desktop.set_value': {
          const target = this.appScoped ? await this.requireScopedWindow('desktop.set_value') : await this.resolveWindow();
          const observedTarget = this.lastObservation?.targets.find((item) => item.targetId === action.targetId);
          const path = observedTarget?.attributes?.axPath ?? '';
          if (!path) {
            throw new CuaError(
              'TARGET_NOT_FOUND',
              `Target ${action.targetId} is not an accessibility target from the latest window observation; observe the app window again.`,
            );
          }
          const result = await this.helper.call('ax_set_value', { pid: target.pid, path, value: action.value });
          actual.setValue = result;
          actual.appName = target.appName;
          actual.windowId = target.windowId;
          this.generationCounter += 1;
          if (result?.matches !== true) return { actual, evidence, sideEffectUnknown: true };
          return { actual, evidence };
        }
        case 'desktop.focus_app':
        case 'desktop.open_app': {
          const result = await this.helper.call('focus', { appName: action.appName });
          actual.focus = result;
          actual.frontmost = (await this.status()).frontmost;
          this.target = undefined;
          this.generationCounter += 1;
          return { actual, evidence };
        }
        case 'desktop.edit_document': {
          const result = await execFileAsync('/usr/bin/osascript', ['-e', TEXTEDIT_SCRIPT, action.content, action.savePath], {
            timeout: 30_000,
            maxBuffer: 2 * 1024 * 1024,
            env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? tmpdir() },
          });
          const info = await stat(action.savePath);
          const saved = await readFile(action.savePath, 'utf8');
          actual.appName = action.appName;
          actual.savePath = action.savePath;
          actual.bytes = info.size;
          actual.contentMatches = saved === action.content;
          actual.stdout = result.stdout.trim().slice(0, 500);
          evidence.push({ kind: 'file', ref: action.savePath });
          this.generationCounter += 1;
          if (!actual.contentMatches) {
            return { actual, evidence, sideEffectUnknown: true };
          }
          return { actual, evidence };
        }
        case 'desktop.click':
        case 'desktop.move':
        case 'desktop.drag':
        case 'desktop.scroll':
        case 'desktop.type':
        case 'desktop.key': {
          if (this.statusCache?.eventAccess !== true) {
            throw new CuaError(
              'DRIVER_UNAVAILABLE',
              'macOS Accessibility/Input Monitoring is not granted. Enable it for this process in System Settings › Privacy & Security, then restart the desktop driver. No input was sent.',
            );
          }
          if (this.appScoped) {
            // Keyboard and pointer input go to whatever is in front, so the
            // scoped window must be verified in front before anything is posted.
            const scoped = await this.requireScopedWindow(action.tool);
            actual.targetWindow = {
              windowId: scoped.windowId,
              appName: scoped.appName,
              title: scoped.title,
              bounds: scoped.bounds,
            };
          }
          const params = this.toHelperParams(action, proposal, this.target);
          const result = await this.helper.call(
            action.tool === 'desktop.click'
              ? 'click'
              : action.tool === 'desktop.move'
                ? 'move'
                : action.tool === 'desktop.drag'
                  ? 'drag'
                  : action.tool === 'desktop.scroll'
                    ? 'scroll'
                    : action.tool === 'desktop.type'
                      ? 'type'
                      : 'key',
            params,
          );
          actual.result = result;
          this.generationCounter += 1;
          return { actual, evidence };
        }
        default:
          throw new CuaError('PROTOCOL_INVALID', `Unsupported desktop action: ${(action as { tool: string }).tool}`);
      }
    } catch (error) {
      if (error instanceof HelperError) {
        if (error.code === 'PERMISSION') {
          throw new CuaError('DRIVER_UNAVAILABLE', error.message, { retryable: false });
        }
        if (error.code === 'TARGET_NOT_FOUND') {
          throw new CuaError('TARGET_NOT_FOUND', error.message);
        }
        if (error.code === 'ACTION_UNSUPPORTED') {
          throw new CuaError('TARGET_NOT_ACTIONABLE', error.message);
        }
        if (error.code === 'ACTION' || error.code === 'DRIVER') {
          throw new CuaError('DRIVER_ERROR', error.message, { retryable: true });
        }
        if (error.code === 'PROTOCOL') {
          throw new CuaError('PROTOCOL_INVALID', error.message);
        }
      }
      throw error;
    }
  }

  /**
   * Bring the scoped window forward when needed and refuse to continue when
   * the window moved since the observation that coordinates came from.
   */
  private async requireScopedWindow(operation: string): Promise<WindowInfo> {
    let live = await this.resolveWindow();
    const observed = this.observedWindow;
    if (observed) {
      if (live.windowId !== observed.windowId) {
        throw new CuaError(
          'TARGET_STALE',
          `The scoped window changed from ${observed.windowId} to ${live.windowId} since the last observation; ${operation} was not sent. Observe again.`,
        );
      }
      if (windowBoundsKey(live.bounds) !== windowBoundsKey(observed.bounds)) {
        throw new CuaError(
          'TARGET_STALE',
          `The scoped window moved or resized since the last observation; ${operation} was not sent. Observe again.`,
        );
      }
    }
    const status = await this.status();
    if (status.frontmost?.pid !== live.pid) {
      live = await this.activateWindow(live);
      if (observed && windowBoundsKey(live.bounds) !== windowBoundsKey(observed.bounds)) {
        throw new CuaError(
          'TARGET_STALE',
          `Activating the app changed the scoped window geometry; ${operation} was not sent. Observe again.`,
        );
      }
    }
    return live;
  }

  /** Convert screenshot pixels to window-local points and refuse out-of-window input. */
  private toWindowPoint(
    x: number,
    y: number,
    observation: Observation | undefined,
    bounds: WindowBounds,
    operation: string,
  ): { x: number; y: number } {
    const meta = observation?.screenshot;
    if (!meta && this.appScoped) {
      throw new CuaError(
        'TARGET_STALE',
        `${operation} needs a fresh app-window observation; the driver has no window screenshot to map coordinates from. Observe the window first.`,
      );
    }
    if (meta && meta.width > 0 && meta.height > 0) {
      const toleranceX = WINDOW_POINT_TOLERANCE * (meta.scaleX || 1);
      const toleranceY = WINDOW_POINT_TOLERANCE * (meta.scaleY || 1);
      if (x < -toleranceX || y < -toleranceY || x > meta.width + toleranceX || y > meta.height + toleranceY) {
        throw new CuaError(
          'AUTHORIZATION_DENIED',
          `${operation} at screenshot pixel ${describePoint({ x, y })} is outside the captured app window (${meta.width}x${meta.height} px, ${Math.round(bounds.width)}x${Math.round(bounds.height)} points); no input was sent.`,
          { retryable: false },
        );
      }
    }
    const local = meta ? screenshotToViewport([x, y], meta) : { x, y };
    if (!isPointInsideWindow(local, bounds)) {
      throw new CuaError(
        'AUTHORIZATION_DENIED',
        `${operation} at ${describePoint(local)} lies outside the scoped app window (${Math.round(bounds.width)}x${Math.round(bounds.height)} at ${describePoint(bounds)}); no input was sent.`,
        { retryable: false },
      );
    }
    return local;
  }

  private toHelperParams(action: DesktopAction, proposal: ActionProposal, window?: WindowInfo): Record<string, unknown> {
    const { observation } = proposal as ActionProposal & { observation?: Observation };
    const bounds = window?.bounds;
    const map = (x: number, y: number, operation: string) => {
      if (!bounds) {
        const meta = observation?.screenshot;
        return meta ? screenshotToViewport([x, y], meta) : { x, y };
      }
      const local = this.toWindowPoint(x, y, observation ?? this.lastObservation, bounds, operation);
      return windowLocalToGlobal(local, bounds);
    };
    switch (action.tool) {
      case 'desktop.click': {
        const p = map(action.x, action.y, 'desktop.click');
        return { x: p.x, y: p.y, button: action.button, count: action.clickCount };
      }
      case 'desktop.move': {
        const p = map(action.x, action.y, 'desktop.move');
        return { x: p.x, y: p.y };
      }
      case 'desktop.drag': {
        const from = map(action.from[0], action.from[1], 'desktop.drag (from)');
        const to = map(action.to[0], action.to[1], 'desktop.drag (to)');
        return { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: action.durationMs };
      }
      case 'desktop.scroll': {
        const p =
          action.x !== undefined && action.y !== undefined
            ? map(action.x, action.y, 'desktop.scroll')
            : bounds
              ? windowLocalToGlobal({ x: bounds.width / 2, y: bounds.height / 2 }, bounds)
              : undefined;
        return { direction: action.direction, amount: action.amount, ...(p ? { x: p.x, y: p.y } : {}) };
      }
      case 'desktop.type':
        return { text: action.text };
      case 'desktop.key': {
        const key = parseMacKeyCombo(action.key);
        return { keyCode: key.keyCode, flags: key.flags };
      }
      default:
        return {};
    }
  }

  async probe(condition: Condition): Promise<ProbeResult> {
    switch (condition.kind) {
      case 'window_title': {
        if (this.appScoped) {
          const window = await this.resolveWindow().catch(() => undefined);
          const combined = `${window?.appName ?? ''} ${window?.title ?? ''}`;
          return {
            verdict: combined.includes(condition.contains) ? 'pass' : 'fail',
            detail: `Scoped window is ${JSON.stringify(combined.trim())}; expected to contain ${JSON.stringify(condition.contains)}.`,
          };
        }
        const status = await this.status().catch(() => this.statusCache);
        const title = status?.frontmost.windowTitle ?? '';
        const app = status?.frontmost.appName ?? '';
        const combined = `${app} ${title}`;
        return {
          verdict: combined.includes(condition.contains) ? 'pass' : 'fail',
          detail: `Frontmost window is ${JSON.stringify(combined)}; expected to contain ${JSON.stringify(condition.contains)}.`,
        };
      }
      default:
        return unsupportedProbe(condition.kind);
    }
  }

  async panic(): Promise<void> {
    await this.helper.call('panic').catch(() => undefined);
  }
}
