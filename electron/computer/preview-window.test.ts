import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent } from 'electron';
import { ComputerPreviewWindow } from './preview-window';
import { COMPUTER_PREVIEW_CHANNELS as CHANNELS } from '../../src/core/computer/preview';

const geometry = { logicalWidth: 1200, logicalHeight: 800, captureWidth: 1200, captureHeight: 800 };
const image = { dataUrl: 'data:image/png;base64,cGl4ZWxz', geometry };

function fakeWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame: {}, send: vi.fn(), setWindowOpenHandler: vi.fn(),
    session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } },
  });
  let destroyed = false;
  let visible = false;
  const win = Object.assign(new EventEmitter(), {
    webContents, isDestroyed: () => destroyed,
    setAlwaysOnTop: vi.fn(), setAspectRatio: vi.fn(), setVisibleOnAllWorkspaces: vi.fn(), setContentProtection: vi.fn(),
    showInactive: vi.fn(() => { visible = true; win.emit('show'); }), isVisible: () => visible,
    minimize: vi.fn(), isMinimized: vi.fn(() => false), restore: vi.fn(), focus: vi.fn(), loadURL: vi.fn(async () => undefined), loadFile: vi.fn(async () => undefined),
    close: vi.fn(() => { destroyed = true; win.emit('closed'); }),
    destroy: vi.fn(() => { destroyed = true; win.emit('closed'); }),
  });
  return win;
}

function harness(extra: { devServerUrl?: string } = {}) {
  const main = fakeWindow();
  const preview = fakeWindow();
  const status = { platform: 'darwin', enabled: true, supported: true, accessibility: true, screenRecording: true, geometry };
  const createWindow = vi.fn((_options: BrowserWindowConstructorOptions) => preview as unknown as BrowserWindow);
  const manager = new ComputerPreviewWindow({
    createWindow, getMainWindow: () => main as unknown as BrowserWindow,
    getStatus: () => ({ ...status }), getWorkArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    preloadPath: '/app/computer-preview-preload.js', indexFile: path.resolve('index.html'), devServerUrl: extra.devServerUrl,
  });
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: any[]) => any>();
  manager.register({ handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => any) => { handlers.set(channel, handler); } } as any);
  const event = (win: ReturnType<typeof fakeWindow>) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame }) as unknown as IpcMainInvokeEvent;
  return { manager, main, preview, createWindow, status, handlers, event };
}

describe('native computer preview manager (mock Electron window)', () => {
  it('creates one movable always-on-top sandboxed viewer without focusing either window', async () => {
    const h = harness();
    await h.manager.open();
    await h.manager.open();
    expect(h.createWindow).toHaveBeenCalledTimes(1);
    expect(h.createWindow.mock.calls[0][0]).toMatchObject({
      movable: true, resizable: true, alwaysOnTop: true, frame: false, show: false, transparent: true, hasShadow: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: '/app/computer-preview-preload.js', webviewTag: false },
    });
    expect(h.preview.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    expect(h.preview.showInactive).toHaveBeenCalledTimes(2);
    expect(h.preview.focus).not.toHaveBeenCalled();
    expect(h.main.focus).not.toHaveBeenCalled();
    expect(h.preview.loadFile).toHaveBeenCalledWith(path.resolve('index.html'), { hash: 'computer-preview' });
  });

  it('rejects other windows and subframes from both privileged IPC surfaces', async () => {
    const h = harness();
    const other = fakeWindow();
    await expect(h.handlers.get(CHANNELS.open)!(h.event(other))).rejects.toThrow(/main application/);
    expect(() => h.manager.assertMain({ ...h.event(h.main), senderFrame: {} } as any)).toThrow(/main application/);
    expect((await h.handlers.get(CHANNELS.open)!(h.event(h.main))).ok).toBe(true);
    expect(() => h.handlers.get(CHANNELS.getState)!(h.event(h.main))).toThrow(/preview window/);
    expect(h.handlers.get(CHANNELS.getState)!(h.event(h.preview))).toHaveProperty('status.enabled', true);
    expect(() => h.handlers.get(CHANNELS.close)!(h.event(other))).toThrow(/main application/);
    expect(() => h.handlers.get(CHANNELS.close)!(h.event(h.preview))).toThrow(/main application/);
    expect(h.handlers.has('computer-preview:panic')).toBe(false);
    expect(h.handlers.has('computer-preview:minimize')).toBe(false);
  });

  it('blocks navigation, popups, permissions and remote resource loading', async () => {
    const h = harness();
    await h.manager.open();
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const preventDefault = vi.fn(); h.preview.webContents.emit(event, { preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    expect(h.preview.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
    const filter = h.preview.webContents.session.webRequest.onBeforeRequest.mock.calls[0][0];
    const done = vi.fn();
    filter({ url: 'https://attacker.example/script.js' }, done);
    expect(done).toHaveBeenLastCalledWith({ cancel: true });
    filter({ url: new URL('file://' + path.resolve('index.html')).href }, done);
    expect(done).toHaveBeenLastCalledWith({ cancel: false });
    filter({ url: 'file:///etc/passwd' }, done);
    expect(done).toHaveBeenLastCalledWith({ cancel: true });
    const permission = vi.fn();
    h.preview.webContents.session.setPermissionRequestHandler.mock.calls[0][0](null, 'media', permission);
    expect(permission).toHaveBeenCalledWith(false);
  });

  it('fences late screenshots after disable/re-enable and emergency stop', async () => {
    const h = harness();
    await h.manager.open();
    const earlier = h.manager.beginScreenshot();
    h.status.enabled = false; h.manager.statusChanged();
    h.status.enabled = true; h.manager.statusChanged();
    h.manager.endScreenshot(image, earlier);
    expect(h.manager.snapshot().shot).toBeNull();
    const current = h.manager.beginScreenshot();
    h.manager.endScreenshot(image, current);
    expect(h.manager.snapshot().shot?.dataUrl).toBe(image.dataUrl);
    const pending = h.manager.beginScreenshot();
    h.status.enabled = false; h.manager.statusChanged(true);
    h.manager.endScreenshot(image, pending);
    expect(h.manager.snapshot().shot).toBeNull();
    expect(h.manager.snapshot().status.enabled).toBe(false);
    expect(h.manager.snapshot().inFlight).toBe(0);
    expect(h.main.webContents.send).toHaveBeenCalledWith('computer:status-changed', expect.objectContaining({ enabled: false }));
  });

  it('reports visibility to the main window and closing the viewer leaves control untouched', async () => {
    const h = harness(); await h.manager.open();
    expect(h.handlers.get(CHANNELS.getVisibility)!(h.event(h.main))).toEqual({ visible: true });
    h.handlers.get(CHANNELS.close)!(h.event(h.main));
    expect(h.manager.visibility()).toEqual({ visible: false });
    expect(h.status.enabled).toBe(true);
    expect(h.main.webContents.send).toHaveBeenCalledWith(CHANNELS.visibility, { visible: false });
  });

  it('does not capture at all while disabled or return pixels after the control generation changed', async () => {
    const h = harness(); h.status.enabled = false;
    const read = vi.fn(async () => image);
    expect(await h.manager.capture(read)).toHaveProperty('error');
    expect(read).not.toHaveBeenCalled();
    h.status.enabled = true;
    let finish!: (value: typeof image) => void;
    const pending = h.manager.capture(() => new Promise((resolve) => { finish = resolve; }));
    h.status.enabled = false; h.manager.statusChanged();
    h.status.enabled = true; h.manager.statusChanged();
    finish(image);
    expect(await pending).not.toHaveProperty('dataUrl');
    expect(h.manager.snapshot().shot).toBeNull();
  });

  it('discards an earlier capture that finishes after a newer request, including its result to the model', async () => {
    const h = harness();
    let finish!: (value: typeof image) => void;
    const earlier = h.manager.capture(() => new Promise((resolve) => { finish = resolve; }));
    const newer = { ...image, dataUrl: 'data:image/png;base64,bmV3' };
    expect(await h.manager.capture(async () => newer)).toEqual(newer);
    finish(image);
    expect(await earlier).not.toHaveProperty('dataUrl');
    expect(h.manager.snapshot().shot?.dataUrl).toBe(newer.dataUrl);
    expect(h.manager.snapshot().inFlight).toBe(0);
  });

  it('records actual results without echoing typed secrets and destroys its window on shutdown', async () => {
    const h = harness(); await h.manager.open();
    h.manager.beginOperation();
    h.manager.endAction({ action: 'type', text: 'secret-value' }, { ok: true, message: 'Typed secret-value' });
    expect(h.manager.snapshot().activity[0].description).toBe('Type 12 characters');
    expect(JSON.stringify(h.manager.snapshot().activity)).not.toContain('secret-value');
    h.manager.beginOperation();
    h.manager.endAction({ action: 'type', text: 'secret-value' }, { ok: false, message: 'osascript failed while typing secret-value' });
    expect(JSON.stringify(h.manager.snapshot().activity)).not.toContain('secret-value');
    expect(h.manager.snapshot().activity[1].detail).toContain('Text input failed');
    expect(h.manager.snapshot().inFlight).toBe(0);
    h.manager.destroy();
    expect(h.preview.destroy).toHaveBeenCalledOnce();
    expect(h.manager.snapshot().shot).toBeNull();
  });

  it('allows only loopback development URLs', async () => {
    const invalid = harness({ devServerUrl: 'https://attacker.example/' });
    await expect(invalid.manager.open()).rejects.toThrow(/packaged app or a local/);
    expect(invalid.createWindow).not.toHaveBeenCalled();
    const local = harness({ devServerUrl: 'http://127.0.0.1:5173/' });
    await local.manager.open();
    expect(local.preview.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173/#computer-preview');
  });

  it('accepts only appearance fields and restores a minimized viewer on reopen', async () => {
    const h = harness();
    const open = h.handlers.get(CHANNELS.open)!;
    expect(await open(h.event(h.main), { locale: 'zh', theme: 'dark' })).toEqual({ ok: true });
    expect(h.manager.snapshot().appearance).toEqual({ locale: 'zh', theme: 'dark' });
    h.preview.isMinimized.mockReturnValue(true);
    await open(h.event(h.main), { locale: 'ja', theme: 'light' });
    expect(h.preview.restore).toHaveBeenCalledOnce();
    expect(h.manager.snapshot().appearance).toEqual({ locale: 'ja', theme: 'light' });
    expect(await open(h.event(h.main), { locale: 'en', theme: 'dark', apiKey: 'must-not-pass' })).toMatchObject({ ok: false });
    expect(h.manager.snapshot().appearance).toEqual({ locale: 'ja', theme: 'light' });
  });
});
