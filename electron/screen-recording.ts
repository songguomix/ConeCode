import { desktopCapturer, shell, systemPreferences } from 'electron';

const settingsUrl = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
let pendingRequest: Promise<void> | undefined;

async function requestOrOpenSettings(): Promise<void> {
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return;

  // On macOS Electron requests access for the running app before it lists
  // screens. Zero-sized thumbnails let the user authorize without taking a shot.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }),
      // Keep Settings reachable if the display backend never returns a source.
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); }),
    ]);
  } catch {
    // Electron rejects enumeration when access still needs to be granted.
  } finally {
    clearTimeout(timer);
  }
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    await shell.openExternal(settingsUrl);
  }
}

/** Run only from an explicit screen permission action, never a status refresh. */
export function requestScreenRecordingAccess(): Promise<void> {
  if (process.platform !== 'darwin') {
    return Promise.reject(new Error('Screen Recording settings are only available on macOS.'));
  }
  return pendingRequest ??= requestOrOpenSettings().finally(() => { pendingRequest = undefined; });
}
