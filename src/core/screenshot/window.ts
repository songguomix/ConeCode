// The screenshot overlay is a separate fullscreen transparent BrowserWindow
// covering the whole display (WeChat-style). It loads the same bundle with
// `#screenshot` in the URL, and main.tsx renders ScreenshotWindowRoot instead
// of the full app when it sees this hash.

export const SCREENSHOT_WINDOW_HASH = '#screenshot';

export function isScreenshotWindowHash(hash: string): boolean {
  return hash === SCREENSHOT_WINDOW_HASH || hash === `${SCREENSHOT_WINDOW_HASH}/`;
}
