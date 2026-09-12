import { describe, it, expect } from 'vitest';
import {
  validateComputerRequest, captureSizeFor, toLogicalPoint, toCapturePoint,
  parseKeyCombo, macModifierFlags, describeAction, MAC_KEYCODES,
  MAX_TYPE_LENGTH, MAX_DURATION_SECONDS, READ_ONLY_ACTIONS,
  type DisplayGeometry, type ComputerRequest,
} from './computer';

// A 16:10 Retina laptop: 1512×982 points, captured at 1400 on the long edge.
const RETINA: DisplayGeometry = {
  logicalWidth: 1512, logicalHeight: 982, captureWidth: 1400, captureHeight: 909,
};

describe('captureSizeFor', () => {
  it('shrinks a large display to the token budget, keeping the shape', () => {
    const size = captureSizeFor(3024, 1964);
    expect(Math.max(size.width, size.height)).toBe(1400);
    expect(size.width / size.height).toBeCloseTo(3024 / 1964, 2);
  });

  it('leaves a small display alone rather than blowing it up', () => {
    expect(captureSizeFor(1280, 800)).toEqual({ width: 1280, height: 800 });
  });

  it('scales by the long edge on a portrait display', () => {
    const size = captureSizeFor(1080, 1920);
    expect(size.height).toBe(1400);
    expect(size.width).toBe(788);
  });
});

describe('coordinate mapping', () => {
  it('maps a point on the screenshot onto the display', () => {
    // Middle of the capture is the middle of the screen.
    expect(toLogicalPoint([700, 454], RETINA)).toEqual({ x: 756, y: 490 });
  });

  it('keeps the origin at the origin', () => {
    expect(toLogicalPoint([0, 0], RETINA)).toEqual({ x: 0, y: 0 });
  });

  it('clamps a point past the edge onto the last pixel, not off-screen', () => {
    expect(toLogicalPoint([5000, 5000], RETINA)).toEqual({ x: 1511, y: 981 });
  });

  it('round-trips back to roughly where it started', () => {
    const original: [number, number] = [420, 310];
    const [x, y] = toCapturePoint(toLogicalPoint(original, RETINA), RETINA);
    expect(Math.abs(x - original[0])).toBeLessThanOrEqual(1);
    expect(Math.abs(y - original[1])).toBeLessThanOrEqual(1);
  });

  it('is an identity when the capture is the display size', () => {
    const same: DisplayGeometry = { logicalWidth: 1280, logicalHeight: 800, captureWidth: 1280, captureHeight: 800 };
    expect(toLogicalPoint([640, 400], same)).toEqual({ x: 640, y: 400 });
  });

  it('survives a degenerate capture instead of producing NaN', () => {
    const broken: DisplayGeometry = { logicalWidth: 1280, logicalHeight: 800, captureWidth: 0, captureHeight: 0 };
    expect(toLogicalPoint([10, 10], broken)).toEqual({ x: 10, y: 10 });
  });
});

describe('parseKeyCombo', () => {
  it('reads a bare key', () => {
    expect(parseKeyCombo('Return')).toEqual({ modifiers: [], key: 'return' });
    expect(parseKeyCombo('a')).toEqual({ modifiers: [], key: 'a' });
  });

  it('reads modifiers', () => {
    expect(parseKeyCombo('cmd+shift+4')).toEqual({ modifiers: ['command', 'shift'], key: '4' });
    expect(parseKeyCombo('ctrl+c')).toEqual({ modifiers: ['control'], key: 'c' });
  });

  it('accepts the synonyms a model is likely to reach for', () => {
    expect(parseKeyCombo('meta+s')?.modifiers).toEqual(['command']);
    expect(parseKeyCombo('alt+tab')?.modifiers).toEqual(['option']);
    expect(parseKeyCombo('Enter')?.key).toBe('return');
    expect(parseKeyCombo('esc')?.key).toBe('escape');
    expect(parseKeyCombo('backspace')?.key).toBe('delete');
    expect(parseKeyCombo('ArrowLeft')?.key).toBe('left');
    expect(parseKeyCombo('PageUp')?.key).toBe('page_up');
  });

  it('is not confused by case or spacing', () => {
    expect(parseKeyCombo('  CMD + Shift + A  ')).toEqual({ modifiers: ['command', 'shift'], key: 'a' });
  });

  it('recovers the key when the separator character is itself the key', () => {
    expect(parseKeyCombo('cmd+-')).toEqual({ modifiers: ['command'], key: '-' });
    expect(parseKeyCombo('-')).toEqual({ modifiers: [], key: '-' });
  });

  it('refuses combos it cannot press rather than pressing something else', () => {
    expect(parseKeyCombo('cmd+nonsense')).toBeNull();
    expect(parseKeyCombo('')).toBeNull();
    expect(parseKeyCombo('cmd')).toBeNull(); // a modifier with no key
    expect(parseKeyCombo('a+b')).toBeNull(); // two keys
  });

  it('maps every named key to a real keycode', () => {
    for (const name of Object.keys(MAC_KEYCODES)) {
      expect(parseKeyCombo(name)?.key, name).toBe(name);
    }
  });
});

describe('macModifierFlags', () => {
  it('ORs the flags together', () => {
    expect(macModifierFlags(['command'])).toBe(0x00100000);
    expect(macModifierFlags(['command', 'shift'])).toBe(0x00120000);
    expect(macModifierFlags([])).toBe(0);
  });
});

describe('validateComputerRequest', () => {
  const ok = (req: ComputerRequest) => expect(validateComputerRequest(req)).toBeNull();
  const rejects = (req: any, match: RegExp) => expect(validateComputerRequest(req)).toMatch(match);

  it('keeps screen inspection actions read-only', () => {
    expect(READ_ONLY_ACTIONS.has('screenshot')).toBe(true);
    expect(READ_ONLY_ACTIONS.has('cursor_position')).toBe(true);
    expect(READ_ONLY_ACTIONS.has('wait')).toBe(true);
    expect(READ_ONLY_ACTIONS.has('left_click')).toBe(false);
  });

  it('accepts the everyday calls', () => {
    ok({ action: 'screenshot' });
    ok({ action: 'left_click', coordinate: [10, 20] });
    ok({ action: 'left_click' });
    ok({ action: 'type', text: 'hello' });
    ok({ action: 'key', text: 'cmd+s' });
    ok({ action: 'scroll', scroll_direction: 'down', scroll_amount: 5 });
    ok({ action: 'wait', duration: 2 });
    ok({ action: 'left_click_drag', start_coordinate: [0, 0], coordinate: [50, 50] });
  });

  it('rejects an action it does not have', () => {
    rejects({ action: 'format_disk' }, /Unknown computer action/);
    rejects({}, /Unknown computer action/);
  });

  it('insists on a coordinate where one is required', () => {
    rejects({ action: 'mouse_move' }, /requires "coordinate"/);
    rejects({ action: 'left_click_drag' }, /requires "coordinate"/);
  });

  it('rejects a malformed coordinate', () => {
    rejects({ action: 'left_click', coordinate: [10] }, /two non-negative numbers/);
    rejects({ action: 'left_click', coordinate: [-5, 10] }, /two non-negative numbers/);
    rejects({ action: 'left_click', coordinate: ['10', '20'] }, /two non-negative numbers/);
    rejects({ action: 'left_click', coordinate: [NaN, 2] }, /two non-negative numbers/);
  });

  it('rejects a coordinate on an action that has nowhere to put it', () => {
    rejects({ action: 'type', text: 'x', coordinate: [1, 2] }, /does not take a coordinate/);
  });

  it('insists on text where one is required', () => {
    rejects({ action: 'type' }, /requires a non-empty "text"/);
    rejects({ action: 'type', text: '' }, /requires a non-empty "text"/);
    rejects({ action: 'key' }, /requires a non-empty "text"/);
  });

  it('rejects a key combo it could not press', () => {
    rejects({ action: 'key', text: 'cmd+nope' }, /Could not read the key combo/);
  });

  it('caps a single type call', () => {
    rejects({ action: 'type', text: 'x'.repeat(MAX_TYPE_LENGTH + 1) }, /type at most/);
    ok({ action: 'type', text: 'x'.repeat(MAX_TYPE_LENGTH) });
  });

  it('checks the scroll arguments', () => {
    rejects({ action: 'scroll' }, /requires "scroll_direction"/);
    rejects({ action: 'scroll', scroll_direction: 'sideways' }, /requires "scroll_direction"/);
    rejects({ action: 'scroll', scroll_direction: 'up', scroll_amount: -1 }, /non-negative/);
  });

  it('will not be told to wait forever', () => {
    rejects({ action: 'wait', duration: MAX_DURATION_SECONDS + 1 }, /may not exceed/);
    rejects({ action: 'wait', duration: -1 }, /non-negative/);
  });
});

describe('describeAction', () => {
  it('reads as a sentence a person can approve or refuse', () => {
    expect(describeAction({ action: 'left_click', coordinate: [420, 310] })).toBe('Click at (420, 310)');
    expect(describeAction({ action: 'type', text: 'hello' })).toBe('Type "hello"');
    expect(describeAction({ action: 'key', text: 'cmd+s' })).toBe('Press cmd+s');
    expect(describeAction({ action: 'scroll', scroll_direction: 'down' })).toBe('Scroll down');
    expect(describeAction({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] }))
      .toBe('Drag from (1, 2) to (3, 4)');
  });

  it('shortens a long typing payload instead of filling the log', () => {
    const description = describeAction({ action: 'type', text: 'x'.repeat(200) });
    expect(description.length).toBeLessThan(80);
    expect(description).toContain('…');
  });
});
