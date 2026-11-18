import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerController } from './controller';
import { MacWindowCaptureError } from './macos-app';
import type { NativeWindow } from './app-target';

const native = vi.hoisted(() => ({
  list: vi.fn(), accessibility: vi.fn(), mediaAccess: vi.fn(), capture: vi.fn(), press: vi.fn(), input: vi.fn(), image: vi.fn(),
}));

vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: native.image },
  screen: { getCursorScreenPoint: () => ({ x: 1, y: 1 }) },
  systemPreferences: {
    isTrustedAccessibilityClient: native.accessibility,
    getMediaAccessStatus: native.mediaAccess,
  },
}));
vi.mock('./macos-app', async (importOriginal) => ({
  ...await importOriginal<typeof import('./macos-app')>(),
  listMacWindows: native.list,
  captureMacWindow: native.capture, pressMacPoint: native.press, runMacInput: native.input,
}));

const a: NativeWindow = { id: '1', pid: 111, name: 'Editor', title: 'private editor title', x: -700, y: 50, width: 800, height: 600 };
const b: NativeWindow = { id: '2', pid: 222, name: 'Browser', title: 'private browser title', x: 150, y: 80, width: 800, height: 600 };

let controller: ComputerController;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  vi.clearAllMocks();
  native.list.mockResolvedValue([a, b, { ...b, id: '3', pid: process.pid }]);
  native.accessibility.mockReturnValue(true);
  native.mediaAccess.mockReturnValue('granted');
  native.capture.mockResolvedValue(Buffer.from('app frame'));
  native.press.mockResolvedValue(undefined);
  native.input.mockResolvedValue('ok');
  native.image.mockReturnValue({
    isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }),
    toDataURL: () => 'data:image/png;base64,YXBw',
  });
  controller = new ComputerController();
  controller.setEnabled(true);
});

const initialPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: initialPlatform });
});

async function select(id: string) {
  return controller.act({ action: 'switch_app', targetId: id, targetRevision: controller.status().targetRevision });
}

async function screenshot() {
  const frame = await controller.screenshot();
  if ('error' in frame) throw new Error(frame.error);
  return frame;
}

describe('desktop computer app scope', () => {
  it('lists app names without capturing pixels or disclosing other window titles to the model', async () => {
    const result = await controller.act({ action: 'list_apps' });
    expect(result.targets?.map(({ id }) => id)).toEqual(['111:1', '222:2']);
    expect(result.message).toContain('222:2: Browser');
    expect(result.message).not.toContain(b.title);
    expect(native.capture).not.toHaveBeenCalled();
    await expect(controller.screenshot()).resolves.toHaveProperty('error');
  });

  it('selects and captures a macOS window without Accessibility permission, but blocks input', async () => {
    native.accessibility.mockReturnValue(false);
    await expect(select('111:1')).resolves.toMatchObject({ ok: true });
    const frame = await screenshot();
    await expect(controller.act({ action: 'key', text: 'Return', frameId: frame.frameId }))
      .resolves.toMatchObject({ ok: false, needsPermission: 'accessibility' });
    expect(native.input).not.toHaveBeenCalled();
  });

  it('captures the selected window when macOS still reports the previous denial', async () => {
    native.mediaAccess.mockReturnValue('denied');
    await select('111:1');
    const frame = await screenshot();
    expect(frame.target.id).toBe('111:1');
    expect(native.capture).toHaveBeenCalledExactlyOnceWith(a, expect.any(AbortSignal));
  });

  it('explains a native capture failure using the current screen permission', async () => {
    await select('111:1');
    native.capture.mockRejectedValue(new MacWindowCaptureError('could not capture this window'));
    native.mediaAccess.mockReturnValue('denied');
    await expect(controller.screenshot()).resolves.toMatchObject({ needsPermission: 'screenRecording' });
    native.mediaAccess.mockReturnValue('granted');
    await expect(controller.screenshot()).resolves.toEqual({ error: 'could not capture this window' });
  });

  it('prioritizes a recycled window ID over a possible permission error from screencapture', async () => {
    await select('111:1');
    native.list.mockResolvedValueOnce([a]).mockResolvedValueOnce([{ ...a, pid: b.pid }]);
    native.capture.mockRejectedValueOnce(new MacWindowCaptureError('could not capture this window'));
    native.mediaAccess.mockReturnValue('denied');
    await expect(controller.screenshot()).resolves.toEqual({ error: expect.stringContaining('no longer available') });
    expect(native.image).not.toHaveBeenCalled();
  });

  it('discards pixels if the window moved during capture and retries at the new bounds', async () => {
    await select('111:1');
    const moved = { ...a, x: a.x + 5, width: a.width + 10 };
    native.list.mockResolvedValueOnce([a]).mockResolvedValue([moved]);
    await expect(controller.screenshot()).resolves.toEqual({ error: expect.stringContaining('moved during capture') });
    expect(native.image).not.toHaveBeenCalled();
    expect((await screenshot()).geometry.logicalWidth).toBe(moved.width);
    expect(native.capture).toHaveBeenLastCalledWith(moved, expect.any(AbortSignal));
  });

  it('preserves target and revision errors when macOS reports denied', async () => {
    native.mediaAccess.mockReturnValue('denied');
    await select('111:1');
    await expect(controller.screenshot(0)).resolves.toEqual({ error: expect.stringContaining('changed') });
    native.list.mockResolvedValue([]);
    await expect(controller.screenshot()).resolves.toEqual({ error: expect.stringContaining('no longer available') });
    expect(native.capture).not.toHaveBeenCalled();
  });

  it('captures only the selected window and maps screenshot coordinates including a negative desktop origin', async () => {
    await expect(select('111:1')).resolves.toMatchObject({ ok: true });
    native.list.mockClear();
    const shot = await screenshot();
    expect(native.list).toHaveBeenCalledTimes(2);
    expect(native.capture).toHaveBeenCalledExactlyOnceWith(a, expect.any(AbortSignal));
    await expect(controller.act({ action: 'left_click', coordinate: [15, 20], frameId: shot.frameId }))
      .resolves.toMatchObject({ ok: true });
    expect(native.press).toHaveBeenCalledExactlyOnceWith(a, { x: -685, y: 70 }, expect.any(AbortSignal));
    await expect(controller.act({ action: 'left_click', coordinate: [800, 10], frameId: shot.frameId }))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining('outside') });
    expect(native.press).toHaveBeenCalledTimes(1);
  });

  it('invalidates stale actions on app switches, window movement and recycled window IDs', async () => {
    const earlier = controller.status().targetRevision;
    await select('111:1');
    const old = await screenshot();
    await select('222:2');
    await expect(controller.act({ action: 'switch_app', targetId: '111:1', targetRevision: earlier }))
      .resolves.toMatchObject({ ok: false });
    await expect(controller.act({ action: 'key', text: 'Return', frameId: old.frameId }))
      .resolves.toMatchObject({ ok: false });
    const fresh = await screenshot();
    native.list.mockResolvedValue([a, { ...b, x: b.x + 1 }]);
    await expect(controller.act({ action: 'key', text: 'Return', frameId: fresh.frameId }))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining('moved') });
    expect(controller.status().frameId).toBeNull();
    native.list.mockResolvedValue([a, { ...b, pid: 333 }]);
    await expect(select('222:2')).resolves.toMatchObject({ ok: false });
    expect(native.input).not.toHaveBeenCalled();
  });

  it('blocks system shortcuts rather than using them to switch apps or capture the desktop', async () => {
    await select('111:1');
    const frame = await screenshot();
    for (const text of ['cmd+tab', 'cmd+shift+4']) {
      await expect(controller.act({ action: 'key', text, frameId: frame.frameId }))
        .resolves.toMatchObject({ ok: false, message: expect.stringContaining('app-only') });
    }
    expect(native.input).not.toHaveBeenCalled();
  });

  it('discards a capture interrupted by emergency stop even if the native reply arrives late', async () => {
    native.mediaAccess.mockReturnValue('denied');
    await select('111:1');
    let finish!: (value: Buffer) => void;
    native.capture.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = controller.screenshot();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await expect(controller.screenshot()).resolves.toEqual({ error: expect.stringContaining('in progress') });
    await controller.panic();
    finish(Buffer.from('late image'));
    await expect(pending).resolves.toHaveProperty('error');
    expect(controller.status()).toMatchObject({ enabled: false, target: null, frameId: null });
    expect(native.image).not.toHaveBeenCalled();
  });
});
