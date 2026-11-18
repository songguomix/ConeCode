import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureWindow, performWindowsAction } from './windows-app';
import { ComputerController } from './controller';
import type { NativeWindow } from './app-target';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: launch }));
vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: () => ({
    isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }),
    toDataURL: () => 'data:image/png;base64,YXBw',
  }) },
}));

const target: NativeWindow = {
  id: '123456', name: 'Editor', title: 'Selected file',
  pid: 99, x: -1200, y: 20, width: 800, height: 600,
};

function nextResult(result: string, error?: Error) {
  const end = vi.fn();
  launch.mockImplementationOnce((_exe, _args, _options, callback) => {
    queueMicrotask(() => callback(error ?? null, result, error?.message ?? ''));
    return { stdin: { end, on: vi.fn() } };
  });
  return end;
}

beforeEach(() => {
  launch.mockReset();
});

describe('scoped Windows app actions', () => {
  it('selects and captures a background window and surfaces a focus refusal only on input', async () => {
    const platform = process.platform;
    vi.stubEnv('SystemRoot', 'C:/Windows');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const controller = new ComputerController();
      controller.setEnabled(true);
      const windows = JSON.stringify([target]);
      const id = `${target.pid}:${target.id}`;
      nextResult(windows);
      await expect(controller.act({ action: 'switch_app', targetId: id, targetRevision: controller.status().targetRevision }))
        .resolves.toMatchObject({ ok: true, target: { id } });
      expect(launch).toHaveBeenCalledTimes(1);

      nextResult(windows);
      const capture = nextResult(Buffer.from('window image').toString('base64'));
      nextResult(windows);
      const shot = await controller.screenshot();
      if ('error' in shot) throw new Error(shot.error);
      expect(shot.target.id).toBe(id);
      expect(capture.mock.calls[0][0]).toContain('[ScopedApp]::Capture(');

      nextResult(windows);
      const refusal = 'The selected app window is not in the foreground. Bring it to the front and try again.';
      const input = nextResult('', new Error(refusal));
      await expect(controller.act({ action: 'key', text: 'Return', frameId: shot.frameId }))
        .resolves.toMatchObject({ ok: false, message: refusal });
      expect(input.mock.calls[0][0]).toContain('[ScopedApp]::Key(');
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
      vi.unstubAllEnvs();
    }
  });

  it('passes just the selected handle and frame to the window capture helper', async () => {
    vi.stubEnv('SystemRoot', 'C:/Windows');
    try {
      const frame = Buffer.from([137, 80, 78, 71]);
      const end = nextResult(frame.toString('base64'));
      const signal = new AbortController().signal;
      expect(await captureWindow(target, signal)).toEqual(frame);
      expect(end.mock.calls[0][0]).toContain('[ScopedApp]::Capture([long]123456, [uint32]99, -1200, 20, 800, 600)');
      expect(launch.mock.calls[0][2]).toMatchObject({ signal, windowsHide: true });
    } finally { vi.unstubAllEnvs(); }
  });

  it('does not launch native input for unsupported shortcuts or clicks without a frame point', async () => {
    await expect(performWindowsAction(target, { action: 'key', text: 'alt+tab' })).rejects.toThrow('unmodified');
    await expect(performWindowsAction(target, { action: 'left_click' })).rejects.toThrow('explicit screenshot coordinate');
    await expect(performWindowsAction(target, { action: 'left_click_drag', coordinate: [3, 5] }, { x: -1190, y: 27 }))
      .rejects.toThrow('not supported');
    expect(launch).not.toHaveBeenCalled();
  });

  it('passes typed content as data without placing it in the command line', async () => {
    vi.stubEnv('SystemRoot', 'C:/Windows');
    try {
      const end = nextResult('');
      const text = '你好 🖋️\n\'"; $x';
      await performWindowsAction(target, { action: 'type', text });
      const script = end.mock.calls[0][0] as string;
      expect(script).not.toContain(text);
      expect(script).toContain(`FromBase64String('${Buffer.from(text, 'utf16le').toString('base64')}')`);
      expect(launch.mock.calls[0][1].join(' ')).not.toContain(text);
    } finally { vi.unstubAllEnvs(); }
  });
});
