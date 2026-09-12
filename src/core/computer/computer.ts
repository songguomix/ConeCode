// The agent's computer-use vocabulary, matching Anthropic's `computer` tool so
// a model already trained on it needs no re-teaching.
//
// Everything here is pure: the action shapes, what counts as a valid call, how a
// coordinate the model picked off a screenshot maps back onto the real display,
// and how a key name becomes something the OS understands. The parts that touch
// the machine live in electron/computer/controller.ts — same split as
// core/exec/sandbox.ts, and for the same reason: these rules are the ones worth
// pinning down in tests.

export type ComputerActionName =
  | 'screenshot'
  | 'cursor_position'
  | 'mouse_move'
  | 'left_click'
  | 'right_click'
  | 'middle_click'
  | 'double_click'
  | 'triple_click'
  | 'left_mouse_down'
  | 'left_mouse_up'
  | 'left_click_drag'
  | 'key'
  | 'hold_key'
  | 'type'
  | 'scroll'
  | 'wait';

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface ComputerRequest {
  action: ComputerActionName;
  /** [x, y] in the coordinate space of the screenshot the model was shown. */
  coordinate?: [number, number];
  /** Drag destination, same space as `coordinate`. */
  start_coordinate?: [number, number];
  /** Text to type, or the key combo for `key`/`hold_key` ("cmd+shift+4"). */
  text?: string;
  scroll_direction?: ScrollDirection;
  scroll_amount?: number;
  /** Seconds, for `wait` and `hold_key`. */
  duration?: number;
}

/** Actions that read the screen or pointer without changing anything. */
export const READ_ONLY_ACTIONS: ReadonlySet<ComputerActionName> = new Set([
  'screenshot', 'cursor_position', 'wait',
]);

const NEEDS_COORDINATE: ReadonlySet<ComputerActionName> = new Set([
  'mouse_move', 'left_click_drag',
]);

/** Clicks may take a coordinate; without one they act wherever the pointer is. */
const OPTIONAL_COORDINATE: ReadonlySet<ComputerActionName> = new Set([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_mouse_down', 'left_mouse_up', 'scroll',
]);

const NEEDS_TEXT: ReadonlySet<ComputerActionName> = new Set(['key', 'hold_key', 'type']);

const ALL_ACTIONS: ReadonlySet<string> = new Set<ComputerActionName>([
  'screenshot', 'cursor_position', 'mouse_move', 'left_click', 'right_click',
  'middle_click', 'double_click', 'triple_click', 'left_mouse_down', 'left_mouse_up',
  'left_click_drag', 'key', 'hold_key', 'type', 'scroll', 'wait',
]);

/** Longest `wait`/`hold_key` we honour, so a bad number can't hang the loop. */
export const MAX_DURATION_SECONDS = 30;
/** Cap on a single `type` call — long text should be typed in chunks. */
export const MAX_TYPE_LENGTH = 2000;

/**
 * Check a tool call before anything touches the machine. Returns an error
 * message written for the model (it will read this and retry), or null if the
 * call is usable.
 */
export function validateComputerRequest(req: ComputerRequest): string | null {
  const action = req?.action;
  if (!action || !ALL_ACTIONS.has(action)) {
    return `Unknown computer action "${action}". Valid actions: ${[...ALL_ACTIONS].join(', ')}.`;
  }

  if (NEEDS_COORDINATE.has(action) && !isCoordinate(req.coordinate)) {
    return `Action "${action}" requires "coordinate": [x, y].`;
  }
  if (req.coordinate !== undefined && !isCoordinate(req.coordinate)) {
    return '"coordinate" must be [x, y] with two non-negative numbers.';
  }
  if (!NEEDS_COORDINATE.has(action) && !OPTIONAL_COORDINATE.has(action) && req.coordinate !== undefined) {
    return `Action "${action}" does not take a coordinate.`;
  }

  if (action === 'left_click_drag' && !isCoordinate(req.start_coordinate) && req.start_coordinate !== undefined) {
    return '"start_coordinate" must be [x, y] with two non-negative numbers.';
  }

  if (NEEDS_TEXT.has(action) && (typeof req.text !== 'string' || req.text.length === 0)) {
    return `Action "${action}" requires a non-empty "text".`;
  }
  if (action === 'type' && req.text!.length > MAX_TYPE_LENGTH) {
    return `"text" is ${req.text!.length} characters; type at most ${MAX_TYPE_LENGTH} per call.`;
  }
  if ((action === 'key' || action === 'hold_key') && parseKeyCombo(req.text!) === null) {
    return `Could not read the key combo "${req.text}". Use names like "Return", "cmd+shift+4", "ctrl+c".`;
  }

  if (action === 'scroll') {
    if (!req.scroll_direction || !['up', 'down', 'left', 'right'].includes(req.scroll_direction)) {
      return 'Action "scroll" requires "scroll_direction" of up, down, left or right.';
    }
    if (req.scroll_amount !== undefined && (!Number.isFinite(req.scroll_amount) || req.scroll_amount < 0)) {
      return '"scroll_amount" must be a non-negative number of clicks.';
    }
  }

  if ((action === 'wait' || action === 'hold_key') && req.duration !== undefined) {
    if (!Number.isFinite(req.duration) || req.duration < 0) return '"duration" must be a non-negative number of seconds.';
    if (req.duration > MAX_DURATION_SECONDS) return `"duration" may not exceed ${MAX_DURATION_SECONDS} seconds.`;
  }

  return null;
}

function isCoordinate(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

// ---- coordinate space ------------------------------------------------------

/**
 * How a capture relates to the display it came from.
 *
 * `logical` is the display's point size — what the OS wants when we post an
 * event. `capture` is the size of the PNG the model actually looked at, which is
 * smaller: screenshots are downscaled to keep them cheap in tokens, and on a
 * Retina screen the native image is larger than the point size to begin with.
 */
export interface DisplayGeometry {
  logicalWidth: number;
  logicalHeight: number;
  captureWidth: number;
  captureHeight: number;
}

/**
 * Pick the capture size sent to the model: the display's aspect ratio, scaled so
 * the long edge is at most `maxEdge`. Bigger buys no accuracy — the model reads
 * layout, not pixels — and costs tokens on every single turn.
 */
export function captureSizeFor(logicalWidth: number, logicalHeight: number, maxEdge = 1400): { width: number; height: number } {
  const longEdge = Math.max(logicalWidth, logicalHeight);
  const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
  return {
    width: Math.max(1, Math.round(logicalWidth * scale)),
    height: Math.max(1, Math.round(logicalHeight * scale)),
  };
}

/**
 * Map a point the model picked off the screenshot onto the display, and clamp it
 * inside the screen. A model that aims slightly off the edge should still hit
 * the edge rather than have the click land nowhere.
 */
export function toLogicalPoint(coordinate: [number, number], geometry: DisplayGeometry): { x: number; y: number } {
  const { logicalWidth, logicalHeight, captureWidth, captureHeight } = geometry;
  const scaleX = captureWidth > 0 ? logicalWidth / captureWidth : 1;
  const scaleY = captureHeight > 0 ? logicalHeight / captureHeight : 1;
  return {
    x: clamp(Math.round(coordinate[0] * scaleX), 0, Math.max(0, logicalWidth - 1)),
    y: clamp(Math.round(coordinate[1] * scaleY), 0, Math.max(0, logicalHeight - 1)),
  };
}

/** The inverse, for reporting the pointer back in the space the model knows. */
export function toCapturePoint(point: { x: number; y: number }, geometry: DisplayGeometry): [number, number] {
  const { logicalWidth, logicalHeight, captureWidth, captureHeight } = geometry;
  const scaleX = logicalWidth > 0 ? captureWidth / logicalWidth : 1;
  const scaleY = logicalHeight > 0 ? captureHeight / logicalHeight : 1;
  return [
    clamp(Math.round(point.x * scaleX), 0, Math.max(0, captureWidth - 1)),
    clamp(Math.round(point.y * scaleY), 0, Math.max(0, captureHeight - 1)),
  ];
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// ---- keys ------------------------------------------------------------------

export type ModifierName = 'command' | 'shift' | 'option' | 'control' | 'fn';

export interface KeyCombo {
  modifiers: ModifierName[];
  /** The non-modifier key, normalised to a lowercase canonical name. */
  key: string;
}

// Every spelling a model might reach for, mapped to one canonical modifier.
const MODIFIER_ALIASES: Record<string, ModifierName> = {
  cmd: 'command', command: 'command', meta: 'command', super: 'command', win: 'command', windows: 'command',
  shift: 'shift',
  alt: 'option', option: 'option', opt: 'option',
  ctrl: 'control', control: 'control',
  fn: 'fn', function: 'fn',
};

// Names for keys that aren't a single character, again accepting the obvious
// synonyms rather than making the model guess ours.
const KEY_ALIASES: Record<string, string> = {
  enter: 'return', return: 'return', ret: 'return',
  esc: 'escape', escape: 'escape',
  del: 'delete', delete: 'delete', backspace: 'delete',
  forwarddelete: 'forward_delete', del_forward: 'forward_delete', 'forward-delete': 'forward_delete',
  space: 'space', spacebar: 'space', ' ': 'space',
  tab: 'tab',
  up: 'up', arrowup: 'up', down: 'down', arrowdown: 'down',
  left: 'left', arrowleft: 'left', right: 'right', arrowright: 'right',
  home: 'home', end: 'end',
  pageup: 'page_up', pgup: 'page_up', page_up: 'page_up',
  pagedown: 'page_down', pgdn: 'page_down', page_down: 'page_down',
  capslock: 'caps_lock', caps_lock: 'caps_lock',
};

/**
 * Read a combo like "cmd+shift+4", "Return" or "ctrl+alt+delete" into its
 * modifiers and one key. Returns null when it can't be understood — the caller
 * turns that into an error the model can act on rather than pressing something
 * arbitrary.
 */
export function parseKeyCombo(combo: string): KeyCombo | null {
  const raw = (combo ?? '').trim();
  if (!raw) return null;

  // Split on + or -, but a lone "+" / "-" is the key itself, not a separator.
  const parts = raw.length === 1 ? [raw] : raw.split(/[+\-]/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  const modifiers: ModifierName[] = [];
  const keys: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    const modifier = MODIFIER_ALIASES[lower];
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
    } else {
      keys.push(lower);
    }
  }

  // "cmd+-" and friends: the separator swallowed the key, so recover it.
  if (keys.length === 0 && /[+\-]$/.test(raw)) keys.push(raw.slice(-1));
  if (keys.length !== 1) return null;

  const key = KEY_ALIASES[keys[0]] ?? keys[0];
  return MAC_KEYCODES[key] === undefined ? null : { modifiers, key };
}

/**
 * macOS virtual keycodes. The values are the ones Carbon has used since forever
 * (Events.h) — CGEventCreateKeyboardEvent wants these, not ASCII.
 */
export const MAC_KEYCODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25,
  '7': 26, '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33,
  i: 34, p: 35, return: 36, l: 37, j: 38, "'": 39, k: 40, ';': 41,
  '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, tab: 48, space: 49,
  '`': 50, delete: 51, escape: 53,
  caps_lock: 57,
  f5: 96, f6: 97, f7: 98, f3: 99, f8: 100, f9: 101, f11: 103, f13: 105,
  f14: 107, f10: 109, f12: 111, f15: 113,
  home: 115, page_up: 116, forward_delete: 117, f4: 118, end: 119, f2: 120,
  page_down: 121, f1: 122, left: 123, right: 124, down: 125, up: 126,
};

/** CGEventFlags bits, OR'd together for the modifiers a keystroke carries. */
export const MAC_MODIFIER_FLAGS: Record<ModifierName, number> = {
  shift: 0x00020000,
  control: 0x00040000,
  option: 0x00080000,
  command: 0x00100000,
  fn: 0x00800000,
};

export function macModifierFlags(modifiers: ModifierName[]): number {
  return modifiers.reduce((flags, m) => flags | (MAC_MODIFIER_FLAGS[m] ?? 0), 0);
}

/** Windows virtual-key codes for the keys that aren't a plain character. */
export const WINDOWS_VKEYS: Record<string, number> = {
  return: 0x0D, tab: 0x09, space: 0x20, delete: 0x08, forward_delete: 0x2E,
  escape: 0x1B, caps_lock: 0x14,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  home: 0x24, end: 0x23, page_up: 0x21, page_down: 0x22,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
};

// ---- description -----------------------------------------------------------

/** One-line summary of a call, for the activity log and the approval card. */
export function describeAction(req: ComputerRequest): string {
  const at = req.coordinate ? ` at (${req.coordinate[0]}, ${req.coordinate[1]})` : '';
  switch (req.action) {
    case 'screenshot': return 'Take a screenshot';
    case 'cursor_position': return 'Read the pointer position';
    case 'mouse_move': return `Move the pointer${at}`;
    case 'left_click': return `Click${at}`;
    case 'right_click': return `Right-click${at}`;
    case 'middle_click': return `Middle-click${at}`;
    case 'double_click': return `Double-click${at}`;
    case 'triple_click': return `Triple-click${at}`;
    case 'left_mouse_down': return `Press the mouse button${at}`;
    case 'left_mouse_up': return `Release the mouse button${at}`;
    case 'left_click_drag': {
      const from = req.start_coordinate ? `(${req.start_coordinate[0]}, ${req.start_coordinate[1]})` : 'the pointer';
      return `Drag from ${from} to (${req.coordinate?.[0]}, ${req.coordinate?.[1]})`;
    }
    case 'key': return `Press ${req.text}`;
    case 'hold_key': return `Hold ${req.text} for ${req.duration ?? 1}s`;
    case 'type': return `Type ${JSON.stringify(truncate(req.text ?? '', 60))}`;
    case 'scroll': return `Scroll ${req.scroll_direction}${at}`;
    case 'wait': return `Wait ${req.duration ?? 1}s`;
    default: return req.action;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
