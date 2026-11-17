import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoScreenshotStore } from './autoScreenshot.store';

describe('useAutoScreenshotStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useAutoScreenshotStore.setState({
      config: {
        defaultTarget: 'auto',
        autoSaveToDisk: false,
        captureDelayMs: 150,
        maxHistory: 24,
      },
      history: [],
      capturing: false,
      lastError: null,
    });
    (globalThis as any).window = {
      electronAPI: {
        autoScreenshot: {
          capture: vi.fn(async (opts: any) => ({
            ok: true,
            target: opts?.target === 'preview' ? 'preview' : 'window',
            width: 1280,
            height: 720,
            dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            timestamp: 1700000000000,
          })),
        },
      },
    };
  });

  it('persists config updates to localStorage', () => {
    useAutoScreenshotStore.getState().setConfig({
      defaultTarget: 'preview',
      autoSaveToDisk: true,
      captureDelayMs: 300,
    });
    const raw = JSON.parse(localStorage.getItem('conecode-auto-screenshot-config') || '{}');
    expect(raw.defaultTarget).toBe('preview');
    expect(raw.autoSaveToDisk).toBe(true);
    expect(raw.captureDelayMs).toBe(300);
  });

  it('captures via IPC and records history items', async () => {
    const res = await useAutoScreenshotStore.getState().captureNow({
      target: 'preview',
      label: 'settings-plugins',
    });
    expect(res.ok).toBe(true);
    expect(res.item?.label).toBe('settings-plugins');
    expect(res.item?.target).toBe('preview');
    expect(res.item?.width).toBe(1280);
    expect(useAutoScreenshotStore.getState().history).toHaveLength(1);
    expect(useAutoScreenshotStore.getState().capturing).toBe(false);
  });

  it('records errors gracefully when IPC fails', async () => {
    (globalThis as any).window.electronAPI.autoScreenshot.capture = vi.fn(async () => ({
      ok: false,
      error: 'Screen Recording permission missing',
      needsPermission: 'screen',
    }));
    const res = await useAutoScreenshotStore.getState().captureNow({ target: 'screen' });
    expect(res.ok).toBe(false);
    expect(res.needsPermission).toBe('screen');
    expect(useAutoScreenshotStore.getState().lastError).toContain('Screen Recording');
    expect(useAutoScreenshotStore.getState().history).toHaveLength(0);
  });
});
