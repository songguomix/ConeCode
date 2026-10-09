import { describe, expect, it } from 'vitest';
import { formatAccelerator, prettyShortcut } from './shortcut';

const chord = (over: Partial<Parameters<typeof formatAccelerator>[0]> = {}) => ({
  key: 's',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe('formatAccelerator', () => {
  it('builds a modifer+key accelerator', () => {
    expect(formatAccelerator(chord({ ctrlKey: true, shiftKey: true }))).toBe('Control+Shift+S');
    expect(formatAccelerator(chord({ metaKey: true, key: ' ' }))).toBe('Command+Space');
    expect(formatAccelerator(chord({ altKey: true, key: 'F5' }))).toBe('Alt+F5');
  });

  it('rejects bare-modifier and modifier-less presses', () => {
    expect(formatAccelerator(chord({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(formatAccelerator(chord({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(formatAccelerator(chord({}))).toBeNull();
    expect(formatAccelerator(chord({ key: 'Enter' }))).toBeNull();
  });

  it('accepts named keys with a modifier', () => {
    expect(formatAccelerator(chord({ key: 'Enter', ctrlKey: true }))).toBe('Control+Enter');
    expect(formatAccelerator(chord({ key: 'ArrowUp', metaKey: true }))).toBe('Command+Up');
  });
});

describe('prettyShortcut', () => {
  it('renders Mac glyphs and Windows chords', () => {
    expect(prettyShortcut('CommandOrControl+Shift+S', true)).toBe('⌘⇧S');
    expect(prettyShortcut('CommandOrControl+Shift+S', false)).toBe('Ctrl+Shift+S');
    expect(prettyShortcut(null)).toBe('');
  });
});
