import { describe, expect, it } from 'vitest';
import { formatPinPrompt, nextPinLabel, pinFromPointer } from './annotate';

describe('annotate helpers', () => {
  it('normalizes pointer coords inside the frame', () => {
    const pin = pinFromPointer(
      { clientX: 150, clientY: 80 },
      { left: 100, top: 40, width: 200, height: 100 },
      '按钮',
    );
    expect(pin).toEqual({ x: 0.25, y: 0.4, label: '按钮' });
  });

  it('rejects clicks outside the frame', () => {
    expect(
      pinFromPointer(
        { clientX: 10, clientY: 10 },
        { left: 100, top: 40, width: 200, height: 100 },
      ),
    ).toBeNull();
  });

  it('formats a Chinese prompt with percentages', () => {
    const text = formatPinPrompt({ id: '1', x: 0.255, y: 0.5, label: '点1' });
    expect(text).toContain('点1');
    expect(text).toContain('25.5%');
    expect(text).toContain('50%');
  });

  it('appends user extra text when present', () => {
    const text = formatPinPrompt({ id: '1', x: 0, y: 0, label: '点1' }, '改这里的颜色');
    expect(text).toContain('改这里的颜色');
  });

  it('numbers labels', () => {
    expect(nextPinLabel(0)).toBe('点1');
    expect(nextPinLabel(2)).toBe('点3');
  });
});
