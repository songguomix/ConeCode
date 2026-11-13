import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { activateMacWindow, runMacInput } from './macos-app';
import type { NativeWindow } from './app-target';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: launch }));

const target: NativeWindow = { id: '12', pid: 101, x: 0, y: 0, width: 640, height: 480, name: 'Editor', title: 'Document' };
const other = { ...target, id: '13', x: 50 };
const axApp = {};
const quartz = (window: NativeWindow) => ({
  kCGWindowNumber: Number(window.id), kCGWindowOwnerPID: window.pid, kCGWindowLayer: 0,
  kCGWindowBounds: { X: window.x, Y: window.y, Width: window.width, Height: window.height },
});

function simulate({ allowFocus = true, stealFocus = false, duplicate = false } = {}) {
  let frontPid = 202;
  let focused: NativeWindow = other;
  let windows = [quartz(other), quartz(target)];
  const post = vi.fn();
  const raise = vi.fn((_window: NativeWindow) => {
    windows = [quartz(target), quartz(other)];
    return 0;
  });
  const attributes = vi.fn((_element, key, value) => {
    if (key === 'AXFrontmost' && allowFocus) frontPid = target.pid;
    if (key === 'AXFocusedWindow' && allowFocus && !stealFocus) focused = value;
    return allowFocus ? 0 : -25205;
  });
  const $ = Object.assign((value: unknown) => value, {
    NSWorkspace: { sharedWorkspace: { get frontmostApplication() {
      return { processIdentifier: String(frontPid), isNil: () => false };
    } } },
    NSRunningApplication: { runningApplicationWithProcessIdentifier: () => ({
      isNil: () => false, activateWithOptions: () => false,
    }) },
    CGWindowListCopyWindowInfo: () => windows,
    AXIsProcessTrusted: () => true,
    AXUIElementCreateApplication: () => axApp,
    AXUIElementSetAttributeValue: attributes,
    AXUIElementPerformAction: raise,
    AXUIElementCopyAttributeValue: (element: NativeWindow, key: string, result: unknown[]) => {
      if (key === 'AXFocusedWindow') result[0] = focused;
      if (key === 'AXWindows') {
        const candidates = [other, target, ...(duplicate ? [{ ...target }] : [])];
        result[0] = { count: candidates.length, objectAtIndex: (i: number) => candidates[i] };
      }
      if (key === 'AXPosition') result[0] = [element.x, element.y];
      if (key === 'AXSize') result[0] = [element.width, element.height];
      if (key === 'AXTitle') result[0] = element.title;
      return 0;
    },
    AXValueGetValue: (pair: number[], _type: number, pointer: Uint8Array) => {
      pointer.set(new Uint8Array(new Float64Array(pair).buffer));
      return true;
    },
    malloc: () => new Uint8Array(16),
    free: () => undefined,
    CGEventGetType: () => 11,
    CGEventPostToPid: post,
  });
  launch.mockImplementationOnce((_file, _args, _options, callback) => ({
    stdin: {
      on: vi.fn(),
      end(source: string) {
        try {
          runInNewContext(source, {
            $, Ref: () => [], ObjC: {
              import: vi.fn(), bindFunction: vi.fn(), unwrap: (v: unknown) => v,
              deepUnwrap: (v: unknown) => v, castRefToObject: (v: unknown) => v,
            },
            delay: () => { if (stealFocus) frontPid = 202; },
          });
          callback(null, 'ok', '');
        } catch (error) {
          callback(error, '', `12:34: execution error: Error: ${String(error)} (-2700)`);
        }
      },
    },
  }));
  return { post, raise, attributes };
}

describe('macOS scoped window focus', () => {
  it('focuses the exact window via Accessibility when AppKit activation does not take effect', async () => {
    const { post, attributes, raise } = simulate();
    await expect(runMacInput(target, 'postScopedEvent({});')).resolves.toBe('ok');
    expect(attributes).toHaveBeenCalledWith(axApp, 'AXFrontmost', true);
    expect(raise).toHaveBeenCalledExactlyOnceWith(target, 'AXRaise');
    expect(attributes).toHaveBeenCalledWith(axApp, 'AXFocusedWindow', target);
    expect(post).toHaveBeenCalledExactlyOnceWith(target.pid, {});
  });

  it('refuses input and shows a recovery hint when macOS leaves another window focused', async () => {
    const { post } = simulate({ allowFocus: false });
    await expect(runMacInput(target, 'postScopedEvent({});')).rejects.toThrow(
      /^Could not focus the selected app window\. Click that window to bring it forward, then try again\.$/,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('stops if a different app takes focus while the request is pending', async () => {
    const { post, attributes } = simulate({ stealFocus: true });
    await expect(runMacInput(target, 'postScopedEvent({});')).rejects.toThrow('Another app gained focus');
    expect(attributes.mock.calls.filter(([, key]) => key === 'AXFrontmost')).toHaveLength(1);
    expect(post).not.toHaveBeenCalled();
  });

  it('does not raise either AX window when two candidates share the same bounds and title', async () => {
    const { raise } = simulate({ duplicate: true });
    await expect(activateMacWindow(target)).rejects.toThrow('Could not focus');
    expect(raise).not.toHaveBeenCalled();
  });
});
