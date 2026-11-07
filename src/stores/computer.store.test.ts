import { afterEach, describe, expect, it, vi } from 'vitest';
import { useComputerStore } from './computer.store';
import type { ComputerStatus } from '../types/ipc.types';

afterEach(() => vi.unstubAllGlobals());

describe('computer control status across windows', () => {
  it('reflects a floating-window panic and clears the old screen without enabling input', () => {
    let receive!: (status: ComputerStatus) => void;
    const unsubscribe = vi.fn();
    const setEnabled = vi.fn();
    vi.stubGlobal('window', { electronAPI: { computer: { onStatus: (callback: typeof receive) => { receive = callback; return unsubscribe; }, setEnabled } } });
    useComputerStore.setState({ enabled: true, lastShot: 'data:image/png;base64,old' });
    const off = useComputerStore.getState().subscribeStatus();
    receive({ enabled: false, supported: true, platform: 'darwin', accessibility: true, screenRecording: true, geometry: null });
    expect(useComputerStore.getState().enabled).toBe(false);
    expect(useComputerStore.getState().lastShot).toBeNull();
    expect(setEnabled).not.toHaveBeenCalled();
    off();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(['refresh', 'setEnabled', 'requestPermissions', 'panic'] as const)('does not let a delayed %s response override a newer stop broadcast', async (method) => {
    let receive!: (status: ComputerStatus) => void;
    let finish!: (status: ComputerStatus) => void;
    const pending = new Promise<ComputerStatus>((resolve) => { finish = resolve; });
    vi.stubGlobal('window', { electronAPI: { computer: {
      status: () => pending, setEnabled: () => pending, requestPermissions: () => pending, panic: () => pending,
      onStatus: (callback: typeof receive) => { receive = callback; return () => {}; },
    } } });
    const off = useComputerStore.getState().subscribeStatus();
    useComputerStore.setState({ enabled: true, lastShot: 'data:image/png;base64,old' });
    const request = method === 'setEnabled' ? useComputerStore.getState().setEnabled(true) : useComputerStore.getState()[method]();
    const stopped: ComputerStatus = { enabled: false, supported: true, platform: 'darwin', accessibility: true, screenRecording: true, geometry: null };
    receive(stopped);
    finish({ ...stopped, enabled: true });
    await request;
    expect(useComputerStore.getState().enabled).toBe(false);
    useComputerStore.getState().setLastShot('data:image/png;base64,late');
    expect(useComputerStore.getState().lastShot).toBeNull();
    off();
  });

  it('ignores a delayed visible response after the native window has closed', async () => {
    let receive!: (state: { visible: boolean }) => void;
    let finish!: (state: { visible: boolean }) => void;
    const pending = new Promise<{ visible: boolean }>((resolve) => { finish = resolve; });
    vi.stubGlobal('window', { electronAPI: { computer: {
      previewStatus: () => pending,
      onPreviewVisibility: (callback: typeof receive) => { receive = callback; return () => {}; },
    } } });
    const off = useComputerStore.getState().subscribeStatus();
    const request = useComputerStore.getState().refreshPreview();
    receive({ visible: false });
    finish({ visible: true });
    await request;
    expect(useComputerStore.getState().previewVisible).toBe(false);
    off();
  });
});
