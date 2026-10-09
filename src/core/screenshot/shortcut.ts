// Pure helpers for the customizable screenshot hotkey (Electron accelerators).

export const IS_MAC_SHORTCUT =
  typeof navigator !== 'undefined' &&
  (/Mac/.test(navigator.platform || '') || /Macintosh/.test(navigator.userAgent || ''));

export interface KeyChord {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Build an Electron accelerator from a keydown chord, or null when the press
 * is not a bindable hotkey (bare modifier, or no modifier at all — a global
 * single key would hijack normal typing).
 */
export function formatAccelerator(e: KeyChord): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const k = e.key;
  let code: string | null = null;
  if (k === ' ') code = 'Space';
  else if (k === 'ArrowUp') code = 'Up';
  else if (k === 'ArrowDown') code = 'Down';
  else if (k === 'ArrowLeft') code = 'Left';
  else if (k === 'ArrowRight') code = 'Right';
  else if (k.length === 1) code = k.toUpperCase();
  else if (
    ['Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Insert'].includes(k)
  ) {
    code = k;
  } else if (/^F\d{1,2}$/i.test(k)) {
    code = k.toUpperCase();
  }
  const mods = [
    e.metaKey && 'Command',
    e.ctrlKey && 'Control',
    e.shiftKey && 'Shift',
    e.altKey && 'Alt',
  ].filter(Boolean) as string[];
  if (!code || mods.length === 0) return null;
  return [...mods, code].join('+');
}

/** Human display for a stored accelerator (⌘⇧S on Mac, Ctrl+Shift+S elsewhere). */
export function prettyShortcut(accelerator: string | null, isMac = IS_MAC_SHORTCUT): string {
  if (!accelerator) return '';
  const pretty = (p: string): string => {
    if (p === 'CommandOrControl') return isMac ? '⌘' : 'Ctrl';
    if (p === 'Command') return '⌘';
    if (p === 'Control') return isMac ? '⌃' : 'Ctrl';
    if (p === 'Shift') return isMac ? '⇧' : 'Shift';
    if (p === 'Alt') return isMac ? '⌥' : 'Alt';
    return p;
  };
  const parts = accelerator.split('+').map(pretty);
  return isMac ? parts.join('') : parts.join('+');
}
