import { CuaError } from '../../protocol/errors.js';

export type MacModifier = 'command' | 'shift' | 'option' | 'control' | 'fn';

const MODIFIERS: Record<string, MacModifier> = {
  cmd: 'command', command: 'command', meta: 'command', super: 'command', win: 'command', windows: 'command',
  shift: 'shift',
  alt: 'option', option: 'option', opt: 'option',
  ctrl: 'control', control: 'control',
  fn: 'fn', function: 'fn',
};

const KEYCODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25,
  '7': 26, '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33,
  i: 34, p: 35, return: 36, enter: 36, l: 37, j: 38, "'": 39, k: 40, ';': 41,
  '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, tab: 48, space: 49,
  '`': 50, delete: 51, backspace: 51, escape: 53, esc: 53,
  caps_lock: 57,
  f5: 96, f6: 97, f7: 98, f3: 99, f8: 100, f9: 101, f11: 103, f13: 105,
  f14: 107, f10: 109, f12: 111, f15: 113,
  home: 115, page_up: 116, forward_delete: 117, f4: 118, end: 119, f2: 120,
  page_down: 121, f1: 122, left: 123, right: 124, down: 125, up: 126,
  arrowleft: 123, arrowright: 124, arrowdown: 125, arrowup: 126,
  pageup: 116, pagedown: 121,
};

const FLAGS: Record<MacModifier, number> = {
  shift: 0x00020000,
  control: 0x00040000,
  option: 0x00080000,
  command: 0x00100000,
  fn: 0x00800000,
};

export interface ParsedMacKey {
  keyCode: number;
  flags: number;
  canonicalKey: string;
  modifiers: MacModifier[];
}

/** Parse "Meta+S", "cmd+shift+4", "Return" into a macOS virtual keycode and flags. */
export function parseMacKeyCombo(combo: string): ParsedMacKey {
  const raw = (combo ?? '').trim();
  if (!raw) throw new CuaError('PROTOCOL_INVALID', 'Key combination is empty.');
  const parts = raw.length === 1 ? [raw] : raw.split('+').map((p) => p.trim()).filter(Boolean);
  const modifiers: MacModifier[] = [];
  const keys: string[] = [];
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (mod) {
      if (!modifiers.includes(mod)) modifiers.push(mod);
    } else {
      keys.push(part.toLowerCase());
    }
  }
  if (keys.length === 0) throw new CuaError('PROTOCOL_INVALID', `Key combination ${combo} has no non-modifier key.`);
  if (keys.length > 1) throw new CuaError('PROTOCOL_INVALID', `Key combination ${combo} contains more than one key.`);
  const canonical = keys[0]!;
  const keyCode = KEYCODES[canonical];
  if (keyCode === undefined) throw new CuaError('PROTOCOL_INVALID', `Unsupported macOS key "${canonical}".`);
  const flags = modifiers.reduce((acc, m) => acc | FLAGS[m], 0);
  return { keyCode, flags, canonicalKey: canonical, modifiers };
}
