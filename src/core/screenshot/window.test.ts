import { describe, expect, it } from 'vitest';
import { SCREENSHOT_WINDOW_HASH, isScreenshotWindowHash } from './window';

describe('isScreenshotWindowHash', () => {
  it('matches only the screenshot overlay hash', () => {
    expect(isScreenshotWindowHash(SCREENSHOT_WINDOW_HASH)).toBe(true);
    expect(isScreenshotWindowHash('#screenshot/')).toBe(true);
    expect(isScreenshotWindowHash('')).toBe(false);
    expect(isScreenshotWindowHash('#/chat')).toBe(false);
    expect(isScreenshotWindowHash('#screenshots')).toBe(false);
  });
});
