import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestScreenRecordingAccess } from './screen-recording';

const electron = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getSources: vi.fn(),
  openSettings: vi.fn(),
}));
vi.mock('electron', () => ({
  systemPreferences: { getMediaAccessStatus: electron.getStatus },
  desktopCapturer: { getSources: electron.getSources },
  shell: { openExternal: electron.openSettings },
}));

describe('macOS screen recording authorization', () => {
  const platform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.resetAllMocks();
    electron.getStatus.mockReturnValue('denied');
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.useRealTimers();
  });

  it('registers the running app before opening Settings, even when enumeration is denied', async () => {
    electron.getSources.mockRejectedValue(new Error('Failed to get sources.'));
    await requestScreenRecordingAccess();
    expect(electron.getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    expect(electron.getSources).toHaveBeenCalledBefore(electron.openSettings);
    expect(electron.openSettings).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });

  it('shares simultaneous requests and recognizes a grant received during the prompt', async () => {
    electron.getStatus.mockReturnValueOnce('not-determined').mockReturnValue('granted');
    await Promise.all([requestScreenRecordingAccess(), requestScreenRecordingAccess()]);
    expect(electron.getSources).toHaveBeenCalledOnce();
    expect(electron.openSettings).not.toHaveBeenCalled();
  });

  it('skips the prompt and Settings if already authorized', async () => {
    electron.getStatus.mockReturnValue('granted');
    await requestScreenRecordingAccess();
    expect(electron.getSources).not.toHaveBeenCalled();
    expect(electron.openSettings).not.toHaveBeenCalled();
  });

  it('keeps Settings reachable when the display service stalls', async () => {
    vi.useFakeTimers();
    electron.getSources.mockImplementation(() => new Promise(() => {}));
    const pending = requestScreenRecordingAccess();
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(electron.openSettings).toHaveBeenCalledOnce();
  });

  it('allows a retry when Settings could not be opened', async () => {
    electron.openSettings.mockRejectedValueOnce(new Error('Settings unavailable'));
    await expect(requestScreenRecordingAccess()).rejects.toThrow('Settings unavailable');
    await requestScreenRecordingAccess();
    expect(electron.openSettings).toHaveBeenCalledTimes(2);
  });

  it('does not invoke macOS APIs on other platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await expect(requestScreenRecordingAccess()).rejects.toThrow('macOS');
    expect(electron.getStatus).not.toHaveBeenCalled();
    expect(electron.getSources).not.toHaveBeenCalled();
    expect(electron.openSettings).not.toHaveBeenCalled();
  });
});
