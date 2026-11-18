import { afterEach, expect, it, vi } from 'vitest';
import { useScreenshotStore } from './screenshot.store';

afterEach(() => {
  useScreenshotStore.getState().close();
  vi.unstubAllGlobals();
});

it('dismisses the main-window permission card when a retry opens the screenshot window', async () => {
  const begin = vi.fn()
    .mockResolvedValueOnce({ ok: false, needsPermission: 'screenRecording' })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal('window', { electronAPI: { screenshot: { begin } } });

  const { start } = useScreenshotStore.getState();
  await start();
  expect(useScreenshotStore.getState()).toMatchObject({ open: true, error: 'permission' });

  await start();
  expect(begin).toHaveBeenCalledTimes(2);
  expect(useScreenshotStore.getState()).toMatchObject({ open: false, starting: false, image: null, error: null });
});
