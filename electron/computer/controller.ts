import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeImage, screen, systemPreferences } from 'electron';
import {
  captureSizeFor, describeAction, macModifierFlags, MAC_KEYCODES, parseKeyCombo,
  READ_ONLY_ACTIONS, validateComputerRequest,
  type ComputerFrame, type ComputerRequest, type ComputerTarget, type DisplayGeometry,
} from '../../src/core/computer/computer';
import type { ComputerPreviewStatus } from '../../src/core/computer/preview';
import { capturePoint, publicTarget, sameWindow, sameWindowBounds, windowPoint, type NativeWindow } from './app-target';
import { activateMacWindow, captureMacWindow, listMacWindows, pressMacPoint, runMacInput } from './macos-app';
import { activateWindow, captureWindow, listWindows, performWindowsAction, windowsCursorPoint } from './windows-app';

export type { ComputerRequest };
export type ComputerStatus = ComputerPreviewStatus;

export interface ComputerActionResult {
  ok: boolean;
  message: string;
  cursor?: [number, number];
  needsPermission?: 'accessibility' | 'screenRecording';
  target?: ComputerTarget;
  targets?: ComputerTarget[];
}

export type Screenshot = ComputerFrame | { error: string; needsPermission?: 'screenRecording' };

interface Frame {
  id: string;
  target: NativeWindow;
  geometry: DisplayGeometry;
}

const POINTER_ACTIONS = new Set<ComputerRequest['action']>([
  'mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_click_drag', 'scroll',
]);

export class ComputerController {
  private enabled = false;
  private target: NativeWindow | null = null;
  private frame: Frame | null = null;
  private targetRevision = 0;
  private operation: AbortController | null = null;

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.targetRevision += 1;
    this.target = null;
    this.frame = null;
    this.operation?.abort();
  }

  async panic(): Promise<void> {
    this.setEnabled(false);
  }

  status(): ComputerStatus {
    const platform = process.platform;
    const supported = platform === 'darwin' || platform === 'win32';
    return {
      platform,
      enabled: this.enabled,
      supported,
      accessibility: platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : supported,
      screenRecording: platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') === 'granted' : supported,
      geometry: this.frame?.geometry ?? null,
      target: this.target && publicTarget(this.target),
      targetRevision: this.targetRevision,
      frameId: this.frame?.id ?? null,
    };
  }

  requestPermissions(): ComputerStatus {
    if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true);
    return this.status();
  }

  isCurrentFrame(id: unknown): boolean {
    return typeof id === 'string' && this.frame?.id === id;
  }

  private async windows(signal?: AbortSignal): Promise<NativeWindow[]> {
    const windows = await (process.platform === 'darwin' ? listMacWindows(signal) : listWindows(signal));
    return windows.filter((window) => window.pid !== process.pid);
  }

  private async currentWindow(target: NativeWindow, signal: AbortSignal): Promise<NativeWindow> {
    const current = (await this.windows(signal)).find((window) => sameWindow(window, target));
    if (!current) throw new Error('The selected app window is no longer available. Select an open window.');
    return current;
  }

  /** Keep switch, capture and input from interleaving; the stop switch can abort any of them. */
  private async exclusive<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.operation) throw new Error('Another computer action is in progress.');
    const controller = new AbortController();
    this.operation = controller;
    try {
      const result = await run(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      this.operation = null;
    }
  }

  async screenshot(expectedRevision?: number): Promise<Screenshot> {
    const status = this.status();
    if (!status.enabled) return { error: 'Computer control is switched off.' };
    if (!status.supported) return { error: `App window capture is not supported on ${status.platform}.` };
    if (!status.screenRecording) {
      return { error: 'Enable Screen Recording for ConeCode in System Settings › Privacy & Security, then restart ConeCode.', needsPermission: 'screenRecording' };
    }
    if (expectedRevision !== undefined && expectedRevision !== this.targetRevision) {
      return { error: 'The selected app changed. Request a new screenshot.' };
    }
    const target = this.target;
    if (!target) return { error: 'Select an app window before capturing a screenshot.' };

    try {
      return await this.exclusive(async (signal) => {
        this.frame = null;
        const current = await this.currentWindow(target, signal);
        signal.throwIfAborted();
        const png = await (status.platform === 'darwin' ? captureMacWindow(current, signal) : captureWindow(current, signal));
        const after = await this.currentWindow(current, signal);
        signal.throwIfAborted();
        if (!sameWindowBounds(current, after)) throw new Error('The app window moved during capture. Request a new screenshot.');
        let image = nativeImage.createFromBuffer(png);
        if (image.isEmpty()) throw new Error('The selected app did not return an image.');
        const nativeSize = image.getSize();
        const size = captureSizeFor(nativeSize.width, nativeSize.height);
        if (nativeSize.width !== size.width || nativeSize.height !== size.height) image = image.resize(size);
        const actual = image.getSize();
        const geometry = {
          logicalWidth: current.width, logicalHeight: current.height,
          captureWidth: actual.width, captureHeight: actual.height,
        };
        const id = randomUUID();
        this.frame = { id, target: after, geometry };
        return { dataUrl: image.toDataURL(), geometry, target: publicTarget(after), frameId: id };
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async act(req: ComputerRequest): Promise<ComputerActionResult> {
    if (!this.enabled) return { ok: false, message: 'Computer control is switched off. Enable it before using an app.' };
    const invalid = validateComputerRequest(req);
    if (invalid) return { ok: false, message: invalid };

    const status = this.status();
    if (!status.supported) return { ok: false, message: `App window control is not supported on ${status.platform}.` };
    if (!status.accessibility && !READ_ONLY_ACTIONS.has(req.action)) {
      return { ok: false, needsPermission: 'accessibility', message: 'Enable Accessibility for ConeCode in System Settings › Privacy & Security, then restart ConeCode.' };
    }
    if (req.action === 'key' || req.action === 'hold_key') {
      const { key, modifiers } = parseKeyCombo(req.text!)!;
      if (modifiers.includes('command') && (key === 'tab' || key === '`' || key === 'space' ||
        (modifiers.includes('shift') && ['3', '4', '5', '6'].includes(key)))) {
        return { ok: false, message: 'System switching and screenshot shortcuts are unavailable in app-only mode. Use switch_app or screenshot.' };
      }
    }
    try {
      switch (req.action) {
        case 'list_apps': {
          const revision = this.targetRevision;
          const targets = (await this.windows()).map(publicTarget);
          if (!this.enabled || this.targetRevision !== revision) throw new Error('The app selection changed while listing windows.');
          return {
            ok: true, targets,
            message: targets.length
              ? 'Available app windows (ID: app):\n' + targets.map(({ id, name }) => `${id}: ${name.replace(/[\r\n]/g, ' ')}`).join('\n')
              : 'No available app windows. Open the desired app first.',
          };
        }
        case 'switch_app': return await this.switchApp(req.targetId!, req.targetRevision);
        case 'screenshot': {
          const shot = await this.screenshot(req.targetRevision);
          return 'error' in shot
            ? { ok: false, message: shot.error, needsPermission: shot.needsPermission }
            : { ok: true, target: shot.target, message: `Captured ${shot.target.name} at ${shot.geometry.captureWidth}×${shot.geometry.captureHeight}.` };
        }
        case 'wait': {
          await this.exclusive((signal) => delay((req.duration ?? 1) * 1000, undefined, { signal }));
          return { ok: true, message: 'Wait finished.' };
        }
        default: return await this.exclusive((signal) => this.perform(req, signal));
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async switchApp(id: string, revision: number | undefined): Promise<ComputerActionResult> {
    if (revision !== this.targetRevision) throw new Error('The app selection changed before this switch was approved. Request it again.');
    return this.exclusive(async (signal) => {
      const target = (await this.windows(signal)).find((window) => publicTarget(window).id === id);
      if (!target) throw new Error('This app window is unavailable. List open apps again.');
      signal.throwIfAborted();
      await (process.platform === 'darwin' ? activateMacWindow(target, signal) : activateWindow(target, signal));
      signal.throwIfAborted();
      this.target = target;
      this.frame = null;
      this.targetRevision += 1;
      return { ok: true, target: publicTarget(target), message: `Switched to ${target.name}. Take a fresh screenshot before acting.` };
    });
  }

  private async perform(req: ComputerRequest, signal: AbortSignal): Promise<ComputerActionResult> {
    const frame = this.frame;
    if (!frame || req.frameId !== frame.id) {
      throw new Error('This action is not bound to the current app screenshot. Take a new screenshot and try again.');
    }
    const current = await this.currentWindow(frame.target, signal).catch((error) => {
      this.frame = null;
      throw error;
    });
    signal.throwIfAborted();
    if (!sameWindowBounds(current, frame.target)) {
      this.frame = null;
      throw new Error('The app window moved or resized. Take a fresh screenshot before acting.');
    }
    if (req.action === 'cursor_position') {
      const point = process.platform === 'darwin' ? screen.getCursorScreenPoint() : await windowsCursorPoint(signal);
      const cursor = capturePoint(point, frame.geometry, current);
      return cursor
        ? { ok: true, cursor, message: `The pointer is at (${cursor.join(', ')}) in the selected window.` }
        : { ok: true, message: 'The pointer is outside the selected window.' };
    }

    if (req.action === 'left_mouse_down' || req.action === 'left_mouse_up') {
      throw new Error('Standalone mouse button holds are unavailable in app-only mode.');
    }
    let point: { x: number; y: number } | undefined;
    if (POINTER_ACTIONS.has(req.action)) {
      if (!req.coordinate) throw new Error('Provide a point from the selected app screenshot.');
      point = windowPoint(req.coordinate, frame.geometry, current);
    }
    signal.throwIfAborted();
    if (process.platform === 'darwin') {
      if (req.action === 'left_click') {
        await pressMacPoint(current, point!, signal);
      } else {
        await runMacInput(current, MAC_INPUT + macSource(req), signal);
      }
    } else {
      await performWindowsAction(current, req, point, signal);
    }
    return { ok: true, target: publicTarget(current), message: `${describeAction(req)} in ${current.name} — sent.` };
  }
}

export const computerController = new ComputerController();

function macSource(req: ComputerRequest): string {
  if (req.action === 'key' || req.action === 'hold_key') {
    const { modifiers, key } = parseKeyCombo(req.text!)!;
    const args = `${MAC_KEYCODES[key]}, ${macModifierFlags(modifiers)}`;
    const hold = req.action === 'hold_key' ? (req.duration ?? 1) : 0;
    return `keyEvent(${args}, true); try { if (${hold} > 0) delay(${hold}); } finally { keyEvent(${args}, false); }`;
  }
  if (req.action === 'type') {
    const points = Array.from(req.text!);
    const parts = [];
    for (let i = 0; i < points.length; i += 16) {
      const chunk = points.slice(i, i + 16).join('');
      const units = Array.from({ length: chunk.length }, (_, index) => chunk.charCodeAt(index));
      parts.push(`typeUnits(${JSON.stringify(units)}); delay(0.012);`);
    }
    return parts.join('\n');
  }
  throw new Error(`Action "${req.action}" is not available for scoped macOS input. Use a left click on a supported control or an app key.`);
}

const MAC_INPUT = `
ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void*', 'unsigned long', 'void*']]);
function keyEvent(code, flags, down) {
  var ev = $.CGEventCreateKeyboardEvent($(), code, down);
  if (flags) $.CGEventSetFlags(ev, flags);
  postScopedEvent(ev);
}
function typeUnits(units) {
  // JXA does not pass JavaScript arrays as the UniChar* this API expects.
  var bytes = new Uint8Array(new Uint16Array(units).buffer);
  var buffer = $.malloc(bytes.length);
  try {
    for (var i = 0; i < bytes.length; i++) buffer[i] = bytes[i];
    var down = $.CGEventCreateKeyboardEvent($(), 0, true);
    $.CGEventKeyboardSetUnicodeString(down, units.length, buffer);
    postScopedEvent(down);
    var up = $.CGEventCreateKeyboardEvent($(), 0, false);
    $.CGEventKeyboardSetUnicodeString(up, units.length, buffer);
    postScopedEvent(up);
  } finally { $.free(buffer); }
}
`;
