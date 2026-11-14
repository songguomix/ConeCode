import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sameWindow, sameWindowBounds, type NativeWindow } from './app-target';

// Quartz window coordinates and CGEvent coordinates both use a top-left
// origin in the global desktop. This query returns metadata only, no pixels.
const WINDOWS = `
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
function onScreenWindows() {
  var windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17, 0)));
  if (!Array.isArray(windows)) throw new Error('macOS did not return a window list.');
  return windows.filter(function (w) {
    var b = w.kCGWindowBounds;
    return w.kCGWindowLayer === 0 && w.kCGWindowOwnerPID > 0 && b && b.Width > 0 && b.Height > 0;
  });
}
function sameBounds(bounds, selected) {
  return bounds.X === selected.x && bounds.Y === selected.y &&
    bounds.Width === selected.width && bounds.Height === selected.height;
}
function selectedWindow(windows, selected) {
  var window = windows.find(function (w) { return w.kCGWindowNumber === Number(selected.id); });
  if (!window || window.kCGWindowOwnerPID !== selected.pid) throw new Error('The selected app window is no longer open.');
  if (!sameBounds(window.kCGWindowBounds, selected)) throw new Error('The selected app window moved or resized. Capture it again.');
  return window;
}
function frontPid() {
  var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return app && !app.isNil() ? Number(app.processIdentifier) : 0;
}
`;

const AX = `
ObjC.import('ApplicationServices');
ObjC.bindFunction('AXValueGetValue', ['bool', ['id', 'int', 'void*']]);
ObjC.bindFunction('malloc', ['void*', ['size_t']]);
ObjC.bindFunction('free', ['void', ['void*']]);
function axAttribute(element, key) {
  var result = Ref();
  return $.AXUIElementCopyAttributeValue(element, $(key), result) === 0
    ? ObjC.castRefToObject(result[0])
    : null;
}
function scopedPoint(windows, target, point) {
  if (point.x < target.x || point.y < target.y ||
      point.x >= target.x + target.width || point.y >= target.y + target.height) {
    throw new Error('The input point is outside the selected app window.');
  }
  var hit = windows.find(function (w) {
    var b = w.kCGWindowBounds;
    return point.x >= b.X && point.y >= b.Y && point.x < b.X + b.Width && point.y < b.Y + b.Height;
  });
  if (!hit || hit.kCGWindowNumber !== Number(target.id)) throw new Error('Another window covers the input point.');
}
function axPair(value, type) {
  if (!value) return null;
  // JXA cannot pass Ref() for the CGPoint/CGSize output of AXValueGetValue.
  var pointer = $.malloc(16);
  try {
    if (!$.AXValueGetValue(value, type, pointer)) return null;
    var bytes = new Uint8Array(16);
    for (var i = 0; i < bytes.length; i++) bytes[i] = pointer[i];
    return new Float64Array(bytes.buffer);
  } finally { $.free(pointer); }
}
function matchesAxWindow(element, target) {
  if (!element) return false;
  var point = axPair(axAttribute(element, 'AXPosition'), 1);
  var size = axPair(axAttribute(element, 'AXSize'), 2);
  return point && size && Math.abs(point[0] - target.x) <= 1 &&
    Math.abs(point[1] - target.y) <= 1 && Math.abs(size[0] - target.width) <= 1 &&
    Math.abs(size[1] - target.height) <= 1;
}
function sameAxElement(first, second) {
  return first && second && $.CFEqual(first, second);
}
function uniqueQuartzWindow(windows, target) {
  var matching = windows.filter(function (window) {
    if (window.kCGWindowOwnerPID !== target.pid) return false;
    var bounds = window.kCGWindowBounds;
    return Math.abs(bounds.X - target.x) <= 2 && Math.abs(bounds.Y - target.y) <= 2 &&
      Math.abs(bounds.Width - target.width) <= 2 && Math.abs(bounds.Height - target.height) <= 2;
  });
  return matching.length === 1 && matching[0].kCGWindowNumber === Number(target.id);
}
function verifyFocus(windows, target, axApp, axWindow) {
  // Quartz z-order is not key focus. An app can have a floating panel above
  // its focused document. Check the AX identity and the Quartz target separately.
  return axWindow && frontPid() === target.pid && uniqueQuartzWindow(windows, target) &&
    matchesAxWindow(axWindow, target) && sameAxElement(axAttribute(axApp, 'AXFocusedWindow'), axWindow);
}
function findAxWindow(windows, axApp, target) {
  if (!uniqueQuartzWindow(windows, target)) return null;
  var candidates = axAttribute(axApp, 'AXWindows');
  var matching = [];
  if (candidates) {
    for (var i = 0; i < Number(candidates.count); i++) {
      var window = candidates.objectAtIndex(i);
      if (matchesAxWindow(window, target)) matching.push(window);
    }
  }
  if (matching.length > 1 && target.title) {
    matching = matching.filter(function (window) {
      var title = axAttribute(window, 'AXTitle');
      return title && ObjC.unwrap(title) === target.title;
    });
  }
  return matching.length === 1 ? matching[0] : null;
}
function focusSelectedWindow(target, axApp) {
  var windows = onScreenWindows();
  selectedWindow(windows, target);
  var axWindow = findAxWindow(windows, axApp, target);
  if (verifyFocus(windows, target, axApp, axWindow)) return axWindow;

  var initialFront = frontPid();
  var reachedTarget = initialFront === target.pid;
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(target.pid);
  if (app.isNil()) throw new Error('The selected app is no longer running.');

  // Activation and AXRaise are requests. Some apps raise a window without
  // making it the main or focused window, and AppKit activation is asynchronous.
  if (initialFront !== target.pid) app.activateWithOptions(0);
  for (var attempt = 0; attempt < 3; attempt++) {
    for (var poll = 0; poll < 8; poll++) {
      windows = onScreenWindows();
      selectedWindow(windows, target);
      if (verifyFocus(windows, target, axApp, axWindow)) return axWindow;
      var front = frontPid();
      if (front === target.pid) reachedTarget = true;
      if (front && front !== target.pid && (reachedTarget || front !== initialFront)) {
        throw new Error('Another app gained focus. Select the app window again.');
      }
      if (poll === 0) {
        if (front !== target.pid) {
          $.AXUIElementSetAttributeValue(axApp, $('AXFrontmost'), $(true));
        }
        axWindow = findAxWindow(windows, axApp, target);
        if (axWindow) {
          // Not all AX attributes are writable. Validate the resulting focus
          // rather than treating a failed setter as a failed window switch.
          $.AXUIElementSetAttributeValue(axWindow, $('AXMain'), $(true));
          $.AXUIElementPerformAction(axWindow, $('AXRaise'));
          if (frontPid() === target.pid) {
            reachedTarget = true;
            $.AXUIElementSetAttributeValue(axApp, $('AXFocusedWindow'), axWindow);
          }
        }
      }
      delay(0.05);
    }
  }
  windows = onScreenWindows();
  selectedWindow(windows, target);
  if (verifyFocus(windows, target, axApp, axWindow)) return axWindow;
  if (!axWindow) {
    throw new Error('Could not identify the selected window through Accessibility. If the app has multiple windows of the same size and position, resize the target and capture it again.');
  }
  throw new Error('Could not focus the selected app window. Click that window to bring it forward, then retry the input action.');
}
`;

function runJxa(source: string, signal?: AbortSignal, timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-'], { signal, timeout }, (error, out, stderr) => {
      if (error) {
        const diagnostic = stderr.trim();
        // Script exceptions include osascript's generic -2700 code, which adds
        // no detail about the window operation that failed.
        const message = diagnostic.match(/execution error:\s*(?:Error:\s*)+([\s\S]+?)\s*\(-2700\)$/)?.[1];
        reject(Object.assign(new Error(message || diagnostic || error.message), { cause: error }));
      } else {
        resolve(out.trim());
      }
    });
    command.stdin!.on('error', reject);
    command.stdin!.end(source);
  });
}

export async function listMacWindows(signal?: AbortSignal): Promise<NativeWindow[]> {
  const output = await runJxa(`${WINDOWS}
JSON.stringify(onScreenWindows().flatMap(function (w) {
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(w.kCGWindowOwnerPID);
  if (app.isNil() || Number(app.activationPolicy) !== 0) return [];
  var b = w.kCGWindowBounds;
  return [{ id: String(w.kCGWindowNumber), pid: w.kCGWindowOwnerPID,
    name: ObjC.unwrap(app.localizedName) || w.kCGWindowOwnerName,
    title: w.kCGWindowName || '', x: b.X, y: b.Y, width: b.Width, height: b.Height }];
}));`, signal);
  return JSON.parse(output) as NativeWindow[];
}

export async function captureMacWindow(window: NativeWindow, signal?: AbortSignal): Promise<Buffer> {
  const assertLive = async () => {
    const live = (await listMacWindows(signal)).find((item) => sameWindow(item, window));
    if (!live || !sameWindowBounds(live, window)) {
      throw new Error('The selected app window closed, moved, or resized. Capture it again.');
    }
  };
  await assertLive();
  const dir = await mkdtemp(join(tmpdir(), 'conecode-window-'));
  const path = join(dir, 'window.png');
  try {
    // -l captures a single Quartz window. -a excludes attached windows and
    // -o excludes its shadow, so image origin is the actual window origin.
    await new Promise<void>((resolve, reject) => {
      execFile('/usr/sbin/screencapture', ['-x', '-a', '-o', '-t', 'png', '-l', window.id, path],
        { signal, timeout: 10_000 }, (error, _stdout, stderr) => {
          if (error) reject(Object.assign(new Error(stderr.trim() || 'macOS could not capture the selected app window.'), { cause: error }));
          else resolve();
        });
    });
    await assertLive();
    return await readFile(path, { signal });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runMacInput(window: NativeWindow, source: string, signal?: AbortSignal): Promise<string> {
  return runJxa(`${WINDOWS}${AX}
var scopedWindow = ${JSON.stringify(window)};
var scopedAX = $.AXUIElementCreateApplication(scopedWindow.pid);
if (!$.AXIsProcessTrusted()) throw new Error('ConeCode needs Accessibility permission to send app input.');
var scopedAXWindow = focusSelectedWindow(scopedWindow, scopedAX);
var pendingRelease = null;
function postScopedEvent(event) {
  var type = $.CGEventGetType(event);
  if (type !== 10 && type !== 11) throw new Error('The macOS app input channel supports keyboard events only.');
  var windows = onScreenWindows();
  selectedWindow(windows, scopedWindow);
  if (!verifyFocus(windows, scopedWindow, scopedAX, scopedAXWindow)) throw new Error('The selected app window lost focus. No further input was sent.');
  if (type === 10) {
    pendingRelease = $.CGEventCreateCopy(event);
    $.CGEventSetType(pendingRelease, 11);
    $.CGEventSetFlags(pendingRelease, 0);
  }
  $.CGEventPostToPid(scopedWindow.pid, event);
  if (type === 11) pendingRelease = null;
}
try {
  ${source}
} finally {
  if (pendingRelease && onScreenWindows().some(function (w) {
    return w.kCGWindowNumber === Number(scopedWindow.id) && w.kCGWindowOwnerPID === scopedWindow.pid;
  })) $.CGEventPostToPid(scopedWindow.pid, pendingRelease);
}
'ok';`, signal, 40_000);
}

export async function pressMacPoint(
  window: NativeWindow, point: { x: number; y: number }, signal?: AbortSignal,
): Promise<void> {
  await runJxa(`${WINDOWS}${AX}
var target = ${JSON.stringify(window)};
var point = ${JSON.stringify(point)};
var axApp = $.AXUIElementCreateApplication(target.pid);
if (!$.AXIsProcessTrusted()) throw new Error('ConeCode needs Accessibility permission to click in an app.');
var axWindow = focusSelectedWindow(target, axApp);
var windows = onScreenWindows();
selectedWindow(windows, target);
scopedPoint(windows, target, point);
var hit = Ref();
if ($.AXUIElementCopyElementAtPosition(axApp, point.x, point.y, hit) !== 0) {
  throw new Error('The selected app does not expose an accessible control at this point.');
}
var element = ObjC.castRefToObject(hit[0]);
var elementWindow = axAttribute(element, 'AXWindow');
windows = onScreenWindows();
selectedWindow(windows, target);
scopedPoint(windows, target, point);
if (!sameAxElement(elementWindow, axWindow) ||
    !verifyFocus(windows, target, axApp, axWindow)) {
  throw new Error('The control does not belong to the selected app window.');
}
if ($.AXUIElementPerformAction(element, $('AXPress')) !== 0) {
  throw new Error('The control at this point does not support an Accessibility click.');
}
'ok';`, signal);
}
