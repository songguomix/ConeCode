import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComputerScreenshot } from '../../types/ipc.types';
import { useComputerStore } from '../../stores/computer.store';
import ComputerPanel, { runPanelWindowTask } from './ComputerPanel';

vi.mock('../../stores', async () => {
  const { useComputerStore: store } = await import('../../stores/computer.store');
  return {
    useComputerStore: Object.assign(() => store.getState(), store),
    useUIStore: () => vi.fn(),
    useLanguageStore: () => ({ t: (key: string) => key, locale: 'en' }),
    useSettingsStore: () => 'ask',
  };
});

const target = { id: '12:4', name: 'Editor', title: 'Notes' };
const shot = {
  dataUrl: 'data:image/png;base64,AAAA', target, frameId: 'frame',
  geometry: { logicalWidth: 10, logicalHeight: 20, captureWidth: 10, captureHeight: 20 },
};
const act = vi.fn();
const screenshot = vi.fn();
const current = () => true;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('window', { electronAPI: { computer: { act, screenshot } } });
  useComputerStore.setState({ enabled: true, supported: true, targetRevision: 3, target, frameId: null, lastShot: null });
});
afterEach(() => vi.unstubAllGlobals());

it('offers window-list and screenshot refresh separately, including when the first frame failed', () => {
  const render = () => renderToStaticMarkup(<ComputerPanel />);
  expect(render()).toContain('computerRefreshWindows');
  expect(render()).toContain('computerPreviewRefresh');
  useComputerStore.setState({ target: null });
  expect(render()).not.toContain('computerPreviewRefresh');
});

it('retries an unsuccessful first frame for the same window without selecting it again', async () => {
  useComputerStore.setState({ target: null });
  act.mockImplementationOnce(async () => {
    useComputerStore.setState({ targetRevision: 4, target });
    return { ok: true, target };
  });
  screenshot.mockResolvedValueOnce({ error: 'Permission missing' }).mockImplementationOnce(async () => {
    useComputerStore.setState({ frameId: shot.frameId });
    return shot;
  });
  expect(await runPanelWindowTask({ action: 'capture', revision: 3, select: target.id }, current, vi.fn())).toBe('Permission missing');
  await runPanelWindowTask({ action: 'capture', revision: 4 }, current, vi.fn());
  expect(act).toHaveBeenCalledExactlyOnceWith({ action: 'switch_app', targetId: target.id, targetRevision: 3 });
  expect(screenshot.mock.calls).toEqual([[4], [4]]);
  expect(useComputerStore.getState().lastShot).toBe(shot.dataUrl);
});

it.each([
  { enabled: false, targetRevision: 4, target: null },
  { enabled: true, targetRevision: 5, target: null },
  { enabled: true, targetRevision: 4, target: { ...target, id: '12:5' } },
])('discards a late capture error after a change of control or target', async (status) => {
  let finish!: (result: ComputerScreenshot) => void;
  screenshot.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const result = runPanelWindowTask({ action: 'capture', revision: 3 }, current, vi.fn());
  useComputerStore.setState(status);
  finish({ error: 'Previous window moved' });
  expect(await result).toBeUndefined();
  expect(useComputerStore.getState().lastShot).toBeNull();
});

it('ignores a superseded window list and refuses a screenshot from stale controls', async () => {
  let latest = true;
  const showApps = vi.fn();
  act.mockResolvedValue({ ok: true, targets: [target] });
  const pending = runPanelWindowTask({ action: 'list', revision: 3 }, () => latest, showApps);
  latest = false;
  await pending;
  expect(showApps).not.toHaveBeenCalled();
  await runPanelWindowTask({ action: 'capture', revision: 2 }, current, showApps);
  expect(screenshot).not.toHaveBeenCalled();
});
