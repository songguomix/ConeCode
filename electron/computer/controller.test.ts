import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerController } from './controller';
import type { NativeWindow } from './app-target';

const native = vi.hoisted(() => ({
  list: vi.fn(), activate: vi.fn(), capture: vi.fn(), press: vi.fn(), input: vi.fn(), image: vi.fn(),
}));

vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: native.image },
  screen: { getCursorScreenPoint: () => ({ x: 1, y: 1 }) },
  systemPreferences: {
    isTrustedAccessibilityClient: () => true,
    getMediaAccessStatus: () => 'granted',
  },
}));
vi.mock('./macos-app', () => ({
  listMacWindows: native.list, activateMacWindow: native.activate,
  captureMacWindow: native.capture, pressMacPoint: native.press, runMacInput: native.input,
}));

const a: NativeWindow = { id: '1', pid: 111, name: 'Editor', title: 'private editor title', x: -700, y: 50, width: 800, height: 600 };
const b: NativeWindow = { id: '2', pid: 222, name: 'Browser', title: 'private browser title', x: 150, y: 80, width: 800, height: 600 };

let controller: ComputerController;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  vi.clearAllMocks();
  native.list.mockResolvedValue([a, b, { ...b, id: '3', pid: process.pid }]);
  native.activate.mockResolvedValue(undefined);
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

  it('captures only the selected window and maps screenshot coordinates including a negative desktop origin', async () => {
    await expect(select('111:1')).resolves.toMatchObject({ ok: true });
    const shot = await screenshot();
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
    await select('111:1');
    let finish!: (value: Buffer) => void;
    native.capture.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = controller.screenshot();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await controller.panic();
    finish(Buffer.from('late image'));
    await expect(pending).resolves.toHaveProperty('error');
    expect(controller.status()).toMatchObject({ enabled: false, target: null, frameId: null });
    expect(native.image).not.toHaveBeenCalled();
  });
});
