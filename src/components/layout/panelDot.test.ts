import { describe, it, expect } from 'vitest';
import { mostUrgentDot } from './panelDot';

describe('the one dot the collapsed panel trigger shows', () => {
  it('shows nothing when no panel has live state', () => {
    expect(mostUrgentDot([null, undefined, null])).toBeNull();
  });

  it('shows the only live signal there is', () => {
    expect(mostUrgentDot([null, 'success', null])).toBe('success');
  });

  it('never lets a running dev server hide the agent driving the mouse', () => {
    // The real regression: picking the first dot in list order meant a green
    // "dev server running" dot masked the red "agent has your keyboard" one,
    // because preview sits above computer in the menu.
    expect(mostUrgentDot(['success', 'error-pulse'])).toBe('error-pulse');
    expect(mostUrgentDot(['error-pulse', 'success'])).toBe('error-pulse');
  });

  it('ranks by urgency, not by position', () => {
    expect(mostUrgentDot(['success', 'warning-pulse'])).toBe('warning-pulse');
    expect(mostUrgentDot(['warning-pulse', 'error'])).toBe('error');
    expect(mostUrgentDot(['error', 'error-pulse'])).toBe('error-pulse');
  });

  it('is stable however the panels are ordered', () => {
    const all = ['success', 'warning-pulse', 'error', 'error-pulse'] as const;
    expect(mostUrgentDot([...all])).toBe('error-pulse');
    expect(mostUrgentDot([...all].reverse())).toBe('error-pulse');
  });
});
