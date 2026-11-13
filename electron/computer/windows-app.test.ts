import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureWindow, performWindowsAction } from './windows-app';
import type { NativeWindow } from './app-target';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: launch }));

const target: NativeWindow = {
  id: '123456', name: 'Editor', title: 'Selected file',
  pid: 99, x: -1200, y: 20, width: 800, height: 600,
};

function nextResult(result: string) {
  const end = vi.fn();
  launch.mockImplementationOnce((_exe, _args, _options, callback) => {
    queueMicrotask(() => callback(null, result, ''));
    return { stdin: { end, on: vi.fn() } };
  });
  return end;
}

beforeEach(() => {
  launch.mockReset();
});

describe('scoped Windows app actions', () => {
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
