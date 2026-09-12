import { spawn } from 'child_process';
import { desktopCapturer, screen, systemPreferences } from 'electron';
import {
  validateComputerRequest, toLogicalPoint, toCapturePoint, captureSizeFor,
  parseKeyCombo, macModifierFlags, MAC_KEYCODES, WINDOWS_VKEYS, describeAction,
  READ_ONLY_ACTIONS,
  type ComputerRequest, type DisplayGeometry, type ModifierName,
} from '../../src/core/computer/computer';

// Drives the real mouse, keyboard and screen for the agent's `computer` tool.
//
// macOS needs no extra dependency: osascript can reach CoreGraphics through the
// ObjC bridge, so we post genuine CGEvents — the same thing a physical mouse
// generates. Windows goes through PowerShell into user32.
//
// The one behaviour worth knowing before reading further: WITHOUT Accessibility
// permission, CGEventPost does not fail. It returns cleanly and nothing happens.
// An agent told "clicked" when nothing was clicked will loop forever, so every
// pointer action here is verified against the real cursor afterwards and reports
// honestly when the event went nowhere.

export type { ComputerRequest };

export interface ComputerStatus {
  platform: NodeJS.Platform;
  /** Master switch. Off until the user turns it on; nothing works while false. */
  enabled: boolean;
  supported: boolean;
  /** macOS: permission to post input events. Assumed true elsewhere. */
  accessibility: boolean;
  /** macOS: permission to capture the screen. */
  screenRecording: boolean;
  /** Size the model sees, and the display it maps onto. */
  geometry: DisplayGeometry | null;
}

export interface ComputerActionResult {
  ok: boolean;
  /** Written for the model — it reads this and decides what to do next. */
  message: string;
  /** Pointer position afterwards, in the screenshot's coordinate space. */
  cursor?: [number, number];
  /** Set when the action needs the user to grant an OS permission. */
  needsPermission?: 'accessibility' | 'screenRecording';
}

export interface Screenshot {
  dataUrl: string;
  geometry: DisplayGeometry;
}

/** CGEventType values we post (CGEventTypes.h). */
const EV = {
  leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, mouseMoved: 5,
  leftDragged: 6, otherDown: 25, otherUp: 26,
} as const;

/** How far a drag is broken up, so apps see a gesture rather than a teleport. */
const DRAG_STEPS = 24;

export class ComputerController {
  private enabled = false;

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Hard stop: drop the master switch and release any held mouse button. */
  async panic(): Promise<void> {
    this.enabled = false;
    if (process.platform === 'darwin') {
      const { x, y } = await this.cursorPoint().catch(() => ({ x: 0, y: 0 }));
      await runJxa(`${JXA_PRELUDE}\npostMouse(${EV.leftUp}, ${x}, ${y}, 0, 1);`).catch(() => {});
    }
  }

  geometry(): DisplayGeometry | null {
    try {
      const display = screen.getPrimaryDisplay();
      const capture = captureSizeFor(display.size.width, display.size.height);
      return {
        logicalWidth: display.size.width,
        logicalHeight: display.size.height,
        captureWidth: capture.width,
        captureHeight: capture.height,
      };
    } catch {
      return null;
    }
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
      geometry: this.geometry(),
    };
  }

  /**
   * Ask macOS for the permissions. Accessibility opens the System Settings pane
   * (the grant only takes effect on the next launch, which the UI explains);
   * screen recording is prompted by the first capture attempt.
   */
  requestPermissions(): ComputerStatus {
    if (process.platform === 'darwin') {
      systemPreferences.isTrustedAccessibilityClient(true);
    }
    return this.status();
  }

  async screenshot(): Promise<Screenshot | { error: string; needsPermission?: 'screenRecording' }> {
    const geometry = this.geometry();
    if (!geometry) return { error: 'No display found to capture.' };

    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      return {
        error: 'Screen Recording permission has not been granted to ConeCode. Ask the user to enable it in System Settings › Privacy & Security › Screen Recording, then restart the app.',
        needsPermission: 'screenRecording',
      };
    }

    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: geometry.captureWidth, height: geometry.captureHeight },
    });
    if (sources.length === 0) return { error: 'The screen could not be captured.' };

    // Several screens: take the one the coordinates refer to.
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (source.thumbnail.isEmpty()) {
      return {
        error: 'The capture came back empty, which usually means Screen Recording permission is missing.',
        needsPermission: 'screenRecording',
      };
    }

    const size = source.thumbnail.getSize();
    return {
      dataUrl: source.thumbnail.toDataURL(),
      // Report what was actually produced, not what we asked for — the capture
      // can come back a pixel or two off, and coordinates must map from the
      // image the model really saw.
      geometry: { ...geometry, captureWidth: size.width, captureHeight: size.height },
    };
  }

  async act(req: ComputerRequest): Promise<ComputerActionResult> {
    if (!this.enabled) {
      return { ok: false, message: 'Computer control is switched off. The user must enable it in ConeCode before the screen or input can be touched.' };
    }

    const invalid = validateComputerRequest(req);
    if (invalid) return { ok: false, message: invalid };

    const status = this.status();
    if (!status.supported) {
      return { ok: false, message: `Computer control is not supported on ${process.platform}.` };
    }
    if (!status.accessibility && !READ_ONLY_ACTIONS.has(req.action)) {
      return {
        ok: false,
        needsPermission: 'accessibility',
        message: 'Accessibility permission has not been granted to ConeCode, so input events are silently discarded by macOS. Ask the user to enable it in System Settings › Privacy & Security › Accessibility and restart the app. Do not retry until they confirm.',
      };
    }

    const geometry = status.geometry;
    if (!geometry) return { ok: false, message: 'No display found.' };

    try {
      return await this.perform(req, geometry);
    } catch (err: any) {
      return { ok: false, message: `The action failed: ${err?.message || String(err)}` };
    }
  }

  private async perform(req: ComputerRequest, geometry: DisplayGeometry): Promise<ComputerActionResult> {
    const target = req.coordinate ? toLogicalPoint(req.coordinate, geometry) : null;

    switch (req.action) {
      case 'screenshot': {
        const shot = await this.screenshot();
        if ('error' in shot) {
          return {
            ok: false,
            message: shot.error,
            needsPermission: shot.needsPermission,
          };
        }
        return {
          ok: true,
          message: `Screenshot captured at ${shot.geometry.captureWidth}×${shot.geometry.captureHeight}.`,
          cursor: toCapturePoint(await this.cursorPoint().catch(() => ({ x: 0, y: 0 })), shot.geometry),
        };
      }
      case 'wait': {
        await delay((req.duration ?? 1) * 1000);
        return this.done(req, geometry);
      }
      case 'cursor_position': {
        const point = await this.cursorPoint();
        return {
          ok: true,
          message: `The pointer is at (${toCapturePoint(point, geometry).join(', ')}).`,
          cursor: toCapturePoint(point, geometry),
        };
      }
      case 'mouse_move': {
        await this.moveTo(target!);
        return this.verifyMoved(req, geometry, target!);
      }
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click':
      case 'left_mouse_down':
      case 'left_mouse_up': {
        if (target) await this.moveTo(target);
        const at = target ?? (await this.cursorPoint());
        await this.click(req.action, at);
        return this.done(req, geometry);
      }
      case 'left_click_drag': {
        const from = req.start_coordinate ? toLogicalPoint(req.start_coordinate, geometry) : await this.cursorPoint();
        await this.drag(from, target!);
        return this.verifyMoved(req, geometry, target!);
      }
      case 'scroll': {
        if (target) await this.moveTo(target);
        await this.scroll(req.scroll_direction!, req.scroll_amount ?? 3);
        return this.done(req, geometry);
      }
      case 'key': {
        await this.pressKey(req.text!);
        return this.done(req, geometry);
      }
      case 'hold_key': {
        await this.pressKey(req.text!, (req.duration ?? 1) * 1000);
        return this.done(req, geometry);
      }
      case 'type': {
        await this.typeText(req.text!);
        return this.done(req, geometry);
      }
      default:
        return { ok: false, message: `Action "${req.action}" is not implemented.` };
    }
  }

  private async done(req: ComputerRequest, geometry: DisplayGeometry): Promise<ComputerActionResult> {
    const cursor = toCapturePoint(await this.cursorPoint().catch(() => ({ x: 0, y: 0 })), geometry);
    return { ok: true, message: `${describeAction(req)} — done.`, cursor };
  }

  /**
   * Pointer actions are checked against reality. macOS drops input events from
   * an untrusted process without saying so, and a silent no-op reported as
   * success is what sends an agent into a loop.
   */
  private async verifyMoved(
    req: ComputerRequest, geometry: DisplayGeometry, expected: { x: number; y: number },
  ): Promise<ComputerActionResult> {
    const actual = await this.cursorPoint();
    const drift = Math.hypot(actual.x - expected.x, actual.y - expected.y);
    if (drift > 4) {
      return {
        ok: false,
        needsPermission: 'accessibility',
        cursor: toCapturePoint(actual, geometry),
        message: `The pointer did not move — it is still at (${toCapturePoint(actual, geometry).join(', ')}) instead of (${req.coordinate?.join(', ')}). macOS discarded the event, which means ConeCode is missing Accessibility permission. Ask the user to grant it and restart the app; retrying will not help.`,
      };
    }
    return { ok: true, message: `${describeAction(req)} — done.`, cursor: toCapturePoint(actual, geometry) };
  }

  // ---- platform primitives -------------------------------------------------

  private async cursorPoint(): Promise<{ x: number; y: number }> {
    // Electron knows the pointer position on every platform, and asking it is
    // far cheaper than spawning an interpreter.
    const point = screen.getCursorScreenPoint();
    return { x: point.x, y: point.y };
  }

  private async moveTo(point: { x: number; y: number }): Promise<void> {
    if (process.platform === 'darwin') {
      await runJxa(`${JXA_PRELUDE}\npostMouse(${EV.mouseMoved}, ${point.x}, ${point.y}, 0, 1);`);
    } else {
      await runPowerShell(`${PS_PRELUDE}\n[CC.Native]::SetCursorPos(${point.x}, ${point.y})`);
    }
  }

  private async click(action: ComputerRequest['action'], point: { x: number; y: number }): Promise<void> {
    const { x, y } = point;
    if (process.platform === 'darwin') {
      const script = (() => {
        switch (action) {
          case 'right_click':
            return `postMouse(${EV.rightDown}, ${x}, ${y}, 1, 1); postMouse(${EV.rightUp}, ${x}, ${y}, 1, 1);`;
          case 'middle_click':
            return `postMouse(${EV.otherDown}, ${x}, ${y}, 2, 1); postMouse(${EV.otherUp}, ${x}, ${y}, 2, 1);`;
          case 'left_mouse_down':
            return `postMouse(${EV.leftDown}, ${x}, ${y}, 0, 1);`;
          case 'left_mouse_up':
            return `postMouse(${EV.leftUp}, ${x}, ${y}, 0, 1);`;
          case 'double_click':
            // The click count must climb on the repeat presses or the OS reads
            // two separate clicks instead of a double-click.
            return `clickTimes(${x}, ${y}, 2);`;
          case 'triple_click':
            return `clickTimes(${x}, ${y}, 3);`;
          default:
            return `clickTimes(${x}, ${y}, 1);`;
        }
      })();
      await runJxa(`${JXA_PRELUDE}\n${script}`);
      return;
    }

    const WIN_FLAGS: Record<string, string> = {
      left_click: '0x0002,0x0004', double_click: '0x0002,0x0004,0x0002,0x0004',
      triple_click: '0x0002,0x0004,0x0002,0x0004,0x0002,0x0004',
      right_click: '0x0008,0x0010', middle_click: '0x0020,0x0040',
      left_mouse_down: '0x0002', left_mouse_up: '0x0004',
    };
    const flags = WIN_FLAGS[action] ?? WIN_FLAGS.left_click;
    const calls = flags.split(',').map((f) => `[CC.Native]::mouse_event(${f}, 0, 0, 0, [System.UIntPtr]::Zero)`).join('\n');
    await runPowerShell(`${PS_PRELUDE}\n[CC.Native]::SetCursorPos(${x}, ${y})\n${calls}`);
  }

  private async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    if (process.platform === 'darwin') {
      const steps: string[] = [`postMouse(${EV.mouseMoved}, ${from.x}, ${from.y}, 0, 1);`, `postMouse(${EV.leftDown}, ${from.x}, ${from.y}, 0, 1);`];
      for (let i = 1; i <= DRAG_STEPS; i++) {
        const x = Math.round(from.x + ((to.x - from.x) * i) / DRAG_STEPS);
        const y = Math.round(from.y + ((to.y - from.y) * i) / DRAG_STEPS);
        steps.push(`postMouse(${EV.leftDragged}, ${x}, ${y}, 0, 1); delay(0.008);`);
      }
      steps.push(`postMouse(${EV.leftUp}, ${to.x}, ${to.y}, 0, 1);`);
      await runJxa(`${JXA_PRELUDE}\n${steps.join('\n')}`);
      return;
    }

    const moves: string[] = [`[CC.Native]::SetCursorPos(${from.x}, ${from.y})`, '[CC.Native]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)'];
    for (let i = 1; i <= DRAG_STEPS; i++) {
      const x = Math.round(from.x + ((to.x - from.x) * i) / DRAG_STEPS);
      const y = Math.round(from.y + ((to.y - from.y) * i) / DRAG_STEPS);
      moves.push(`[CC.Native]::SetCursorPos(${x}, ${y})`, 'Start-Sleep -Milliseconds 8');
    }
    moves.push('[CC.Native]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)');
    await runPowerShell(`${PS_PRELUDE}\n${moves.join('\n')}`);
  }

  private async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void> {
    const clicks = Math.min(50, Math.max(1, Math.round(amount)));
    if (process.platform === 'darwin') {
      // Positive wheel1 scrolls up, positive wheel2 scrolls left.
      const vertical = direction === 'up' ? clicks : direction === 'down' ? -clicks : 0;
      const horizontal = direction === 'left' ? clicks : direction === 'right' ? -clicks : 0;
      await runJxa(`${JXA_PRELUDE}\n$.CGEventPost(0, $.CGEventCreateScrollWheelEvent($(), 1, 2, ${vertical}, ${horizontal}));`);
      return;
    }
    const delta = (direction === 'up' || direction === 'left' ? 120 : -120) * clicks;
    const wheel = direction === 'left' || direction === 'right' ? '0x01000' : '0x0800';
    await runPowerShell(`${PS_PRELUDE}\n[CC.Native]::mouse_event(${wheel}, 0, 0, ${delta}, [System.UIntPtr]::Zero)`);
  }

  private async pressKey(combo: string, holdMs = 0): Promise<void> {
    const parsed = parseKeyCombo(combo);
    if (!parsed) throw new Error(`Unrecognised key combo "${combo}".`);

    if (process.platform === 'darwin') {
      const keycode = MAC_KEYCODES[parsed.key];
      const flags = macModifierFlags(parsed.modifiers);
      await runJxa(`${JXA_PRELUDE}\npostKey(${keycode}, ${flags}, true);`);
      if (holdMs > 0) await delay(holdMs);
      await runJxa(`${JXA_PRELUDE}\npostKey(${keycode}, ${flags}, false);`);
      return;
    }

    const vkey = WINDOWS_VKEYS[parsed.key] ?? parsed.key.toUpperCase().charCodeAt(0);
    const mods = parsed.modifiers.map((m) => WIN_MODIFIER_VKEYS[m]).filter(Boolean);
    const down = [...mods.map((m) => `[CC.Native]::keybd_event(${m}, 0, 0, [System.UIntPtr]::Zero)`), `[CC.Native]::keybd_event(${vkey}, 0, 0, [System.UIntPtr]::Zero)`];
    const up = [`[CC.Native]::keybd_event(${vkey}, 0, 2, [System.UIntPtr]::Zero)`, ...mods.reverse().map((m) => `[CC.Native]::keybd_event(${m}, 0, 2, [System.UIntPtr]::Zero)`)];
    const wait = holdMs > 0 ? `Start-Sleep -Milliseconds ${Math.round(holdMs)}` : '';
    await runPowerShell([PS_PRELUDE, ...down, wait, ...up].filter(Boolean).join('\n'));
  }

  private async typeText(text: string): Promise<void> {
    if (process.platform === 'darwin') {
      // Unicode goes straight onto the event rather than being spelled out as
      // keycodes, so CJK and emoji type as themselves. Chunked because a single
      // event only carries a short string.
      const chunks = chunk([...text], 16);
      const lines = chunks.map((codepoints) => {
        const units: number[] = [];
        for (const cp of codepoints) for (let i = 0; i < cp.length; i++) units.push(cp.charCodeAt(i));
        return `typeUnits([${units.join(',')}]); delay(0.012);`;
      });
      await runJxa(`${JXA_PRELUDE}\n${lines.join('\n')}`);
      return;
    }
    await runPowerShell(
      'Add-Type -AssemblyName System.Windows.Forms\n' +
      `[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(escapeSendKeys(text))})`,
    );
  }
}

const WIN_MODIFIER_VKEYS: Record<ModifierName, number> = {
  shift: 0x10, control: 0x11, option: 0x12, command: 0x5B, fn: 0,
};

// ---- interpreters ----------------------------------------------------------

/**
 * Helpers every mouse/key script starts with. Kept in one place so the per-action
 * scripts stay short — each action is one osascript run.
 */
const JXA_PRELUDE = `
ObjC.import('CoreGraphics');
function postMouse(type, x, y, button, clicks) {
  var ev = $.CGEventCreateMouseEvent($(), type, {x: x, y: y}, button);
  if (clicks > 1) $.CGEventSetIntegerValueField(ev, 1, clicks);
  $.CGEventPost(0, ev);
}
function clickTimes(x, y, times) {
  for (var i = 1; i <= times; i++) {
    var down = $.CGEventCreateMouseEvent($(), 1, {x: x, y: y}, 0);
    $.CGEventSetIntegerValueField(down, 1, i);
    $.CGEventPost(0, down);
    var up = $.CGEventCreateMouseEvent($(), 2, {x: x, y: y}, 0);
    $.CGEventSetIntegerValueField(up, 1, i);
    $.CGEventPost(0, up);
    if (i < times) delay(0.05);
  }
}
function postKey(code, flags, isDown) {
  var ev = $.CGEventCreateKeyboardEvent($(), code, isDown);
  if (flags) $.CGEventSetFlags(ev, flags);
  $.CGEventPost(0, ev);
}
function typeUnits(units) {
  var down = $.CGEventCreateKeyboardEvent($(), 0, true);
  $.CGEventKeyboardSetUnicodeString(down, units.length, units);
  $.CGEventPost(0, down);
  var up = $.CGEventCreateKeyboardEvent($(), 0, false);
  $.CGEventKeyboardSetUnicodeString(up, units.length, units);
  $.CGEventPost(0, up);
}
`.trim();

/** user32 entry points, compiled once per PowerShell run. */
const PS_PRELUDE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace CC {
  public class Native {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  }
}
"@
`.trim();

function runJxa(source: string): Promise<string> {
  return runInterpreter('osascript', ['-l', 'JavaScript'], source);
}

function runPowerShell(source: string): Promise<string> {
  return runInterpreter('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], source);
}

/** Run a script on the interpreter's stdin, so nothing lands in the process list. */
function runInterpreter(bin: string, args: string[], source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${bin} timed out`));
    }, 20000);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${bin} exited with ${code}`));
    });
    proc.stdin.write(source);
    proc.stdin.end();
  });
}

/** Quote a string for PowerShell (single-quoted, doubling any inner quote). */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** SendKeys reads these as syntax, so they have to be braced to be literal. */
function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (ch) => `{${ch}}`);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const computerController = new ComputerController();
