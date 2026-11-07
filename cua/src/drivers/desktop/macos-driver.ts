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
  private surface = 'desktop_main';
  private observedEnvironment?: string;

  constructor(
    private readonly ctx: DriverContext,
    private readonly environment: Extract<Environment, { kind: 'desktop' }>,
    private readonly artifacts: ArtifactStore,
    private readonly options: { helperPath?: string } = {},
  ) {
    this.helper = new HelperClient(options.helperPath ?? join(process.cwd(), 'native', 'bin', 'desktop-agent'));
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
        'desktop.scroll', 'desktop.screenshot', 'desktop.focus_app', 'desktop.open_app',
        'desktop.edit_document', 'code.run', 'task.finish',
      ],
      notes: [
        'Mouse/keyboard input requires macOS Accessibility/Input Monitoring permission; without it actions fail explicitly, they do not report false success.',
        'Screenshots cover the main display only. Multi-display coordinates are not claimed to be supported.',
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
    const status = await this.status();
    const identity = JSON.stringify({ screens: status.screens, frontmost: status.frontmost });
    if (this.observedEnvironment && identity !== this.observedEnvironment) this.generationCounter += 1;
    this.observedEnvironment = identity;
    return { surfaceId: this.surface, generation: this.generationCounter };
  }

  async status(): Promise<HelperStatus> {
    if (!this.started) throw new CuaError('DRIVER_UNAVAILABLE', 'Desktop driver is not started.');
    const status = (await this.helper.call('status')) as HelperStatus;
    this.statusCache = status;
    return status;
  }

  async capture(): Promise<{ meta: ScreenshotMeta; status: HelperStatus }> {
    if (!this.started) throw new CuaError('DRIVER_UNAVAILABLE', 'Desktop driver is not started.');
    const permissions = await this.status();
    if (!permissions.screenRecording) throw new CuaError('DRIVER_UNAVAILABLE', 'Screen Recording permission is missing; no desktop screenshot was captured.');
    const temp = join(tmpdir(), `cua-desktop-${randomUUID()}.png`);
    try {
      const result = await this.helper.call('screenshot', { path: temp });
      const status = (await this.helper.call('status')) as HelperStatus;
      this.statusCache = status;
      const bytes = await readFile(temp);
      const artifact = await this.artifacts.save({
        taskId: this.ctx.taskId,
        kind: 'desktop-screenshot',
        bytes,
        extension: '.png',
        meta: { sessionId: this.ctx.sessionId, display: result.screenRecording },
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
        offsetX: 0,
        offsetY: 0,
        devicePixelRatio: result.scale,
        fullPage: false,
      };
      return { meta, status };
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  async observe(): Promise<Observation> {
    const { meta, status } = await this.capture();
    this.observedEnvironment = JSON.stringify({ screens: status.screens, frontmost: status.frontmost });
    this.generationCounter += 1;
    const front = status.frontmost;
    const notes = [
      'Desktop observations are visual: no accessibility control tree is read.',
      'A screenshot covers the main display; absence outside it is not evidence.',
      ...(status.eventAccess
        ? []
        : ['Accessibility/Input Monitoring is not granted; pointer, keyboard and text input are unavailable until the user grants it and restarts the driver.']),
    ];
    return ObservationSchema.parse({
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
        case 'desktop.focus_app':
        case 'desktop.open_app': {
          const result = await this.helper.call('focus', { appName: action.appName });
          actual.focus = result;
          actual.frontmost = (await this.status()).frontmost;
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
          const params = this.toHelperParams(action, proposal);
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
      if (error instanceof HelperError && error.code === 'PERMISSION') {
        throw new CuaError('DRIVER_UNAVAILABLE', error.message, { retryable: false });
      }
      throw error;
    }
  }

  private toHelperParams(action: DesktopAction, proposal: ActionProposal): Record<string, unknown> {
    const obs = (proposal as unknown as { observation?: Observation }).observation;
    const meta = obs?.screenshot;
    const toLogical = (x: number, y: number) => {
      if (!meta) return { x, y };
      const p = screenshotToViewport([x, y], meta);
      return { x: p.x, y: p.y };
    };
    switch (action.tool) {
      case 'desktop.click': {
        const p = toLogical(action.x, action.y);
        return { x: p.x, y: p.y, button: action.button, count: action.clickCount };
      }
      case 'desktop.move': {
        const p = toLogical(action.x, action.y);
        return { x: p.x, y: p.y };
      }
      case 'desktop.drag': {
        const from = toLogical(action.from[0], action.from[1]);
        const to = toLogical(action.to[0], action.to[1]);
        return { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: action.durationMs };
      }
      case 'desktop.scroll': {
        const p = action.x !== undefined && action.y !== undefined ? toLogical(action.x, action.y) : undefined;
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
