import { describe, expect, it } from 'vitest';
import {
  appWindowSurfaceId,
  axNodesToTargets,
  globalToWindowLocal,
  isPointInsideWindow,
  pruneAxTreeToWindow,
  selectAppWindow,
  windowBoundsKey,
  windowLocalToGlobal,
  type AxNode,
  type WindowInfo,
} from '../src/drivers/desktop/app-scope.js';

const windowA: WindowInfo = {
  windowId: 41,
  pid: 900,
  appName: 'TextEdit',
  bundleId: 'com.apple.TextEdit',
  title: 'notes.txt',
  bounds: { x: 100, y: 80, width: 800, height: 600 },
};

const windowB: WindowInfo = {
  windowId: 42,
  pid: 900,
  appName: 'TextEdit',
  bundleId: 'com.apple.TextEdit',
  title: 'draft.txt',
  bounds: { x: 20, y: 20, width: 640, height: 480 },
};

const otherApp: WindowInfo = {
  windowId: 77,
  pid: 901,
  appName: 'Finder',
  bundleId: 'com.apple.finder',
  title: 'Desktop',
  bounds: { x: 0, y: 0, width: 1200, height: 800 },
};

describe('selectAppWindow', () => {
  it('picks the frontmost matching window and never another app', () => {
    expect(selectAppWindow([windowB, windowA, otherApp], { appName: 'TextEdit' })).toBe(windowB);
    expect(selectAppWindow([otherApp, windowA], { bundleId: 'com.apple.TextEdit' })).toBe(windowA);
    expect(selectAppWindow([windowA, otherApp], { appName: 'finder' })).toBe(otherApp);
  });

  it('matches a bundle name even when the app name is localised', () => {
    const localised: WindowInfo = { ...windowA, appName: '文本编辑', bundleName: 'TextEdit' };
    expect(selectAppWindow([localised], { appName: 'textedit' })).toBe(localised);
    expect(selectAppWindow([localised], { bundleId: 'com.apple.TextEdit' })).toBe(localised);
    expect(() => selectAppWindow([localised], { appName: 'Finder' })).toThrowError(/No window matched/);
  });

  it('honours an explicit window id and a title filter', () => {
    expect(selectAppWindow([windowB, windowA], { windowId: 41 })).toBe(windowA);
    expect(selectAppWindow([windowB, windowA], { appName: 'TextEdit', windowTitle: 'draft' })).toBe(windowB);
  });

  it('fails loudly with the reason instead of selecting something else', () => {
    expect(() => selectAppWindow([windowA, otherApp], { appName: 'Mail' })).toThrowError(/No window matched/);
    expect(() => selectAppWindow([windowA], { windowId: 999 })).toThrowError(/Window 999 is not open/);
    expect(() => selectAppWindow([], { appName: 'TextEdit' })).toThrowError(/nothing was read or operated/);
  });

  it('ignores slivers that no one could operate', () => {
    const sliver: WindowInfo = { ...windowA, windowId: 43, bounds: { ...windowA.bounds, height: 1 } };
    expect(selectAppWindow([sliver, windowA], { appName: 'TextEdit' })).toBe(windowA);
  });
});

describe('window coordinate mapping', () => {
  it('round-trips between window-local and screen points', () => {
    const global = windowLocalToGlobal({ x: 12, y: 34 }, windowA.bounds);
    expect(global).toEqual({ x: 112, y: 114 });
    expect(globalToWindowLocal(global, windowA.bounds)).toEqual({ x: 12, y: 34 });
  });

  it('only accepts points inside the window, with a small edge tolerance', () => {
    expect(isPointInsideWindow({ x: 0, y: 0 }, windowA.bounds)).toBe(true);
    expect(isPointInsideWindow({ x: 800, y: 600 }, windowA.bounds)).toBe(true);
    expect(isPointInsideWindow({ x: -5, y: 10 }, windowA.bounds)).toBe(false);
    expect(isPointInsideWindow({ x: 900, y: 10 }, windowA.bounds)).toBe(false);
  });

  it('keys bounds on rounded values so sub-pixel jitter is not staleness', () => {
    expect(windowBoundsKey(windowA.bounds)).toBe('100,80,800,600');
    expect(windowBoundsKey({ ...windowA.bounds, x: 100.4 })).toBe('100,80,800,600');
  });
});

const tree: AxNode[] = [
  { path: '', role: 'AXApplication', depth: 0 },
  {
    path: '0',
    role: 'AXWindow',
    title: 'notes.txt',
    depth: 1,
    x: 100,
    y: 80,
    width: 800,
    height: 600,
  },
  {
    path: '0/0',
    role: 'AXScrollArea',
    depth: 2,
    x: 100,
    y: 130,
    width: 800,
    height: 540,
  },
  {
    path: '0/0/0',
    role: 'AXTextArea',
    value: 'hello',
    depth: 3,
    x: 110,
    y: 140,
    width: 700,
    height: 500,
    actions: ['AXSetValue'],
  },
  {
    path: '0/1',
    role: 'AXButton',
    title: 'Save',
    depth: 2,
    x: 820,
    y: 90,
    width: 70,
    height: 28,
    actions: ['AXPress'],
  },
  {
    path: '1',
    role: 'AXWindow',
    title: 'draft.txt',
    depth: 1,
    x: 20,
    y: 20,
    width: 640,
    height: 480,
  },
  {
    path: '1/0',
    role: 'AXButton',
    title: 'Discard',
    depth: 2,
    x: 30,
    y: 30,
    width: 60,
    height: 20,
    actions: ['AXPress'],
  },
];

describe('pruneAxTreeToWindow', () => {
  it('keeps only the subtree of the scoped window', () => {
    const pruned = pruneAxTreeToWindow(tree, windowA.bounds);
    expect(pruned.matched).toBe(true);
    const paths = pruned.nodes.map((node) => node.path);
    expect(paths).toContain('0/0/0');
    expect(paths).toContain('0/1');
    expect(paths).not.toContain('1/0');
    expect(paths).not.toContain('1');
  });

  it('reports no match when the window frame changed', () => {
    const pruned = pruneAxTreeToWindow(tree, { ...windowA.bounds, x: 400 });
    expect(pruned.matched).toBe(false);
  });
});

describe('axNodesToTargets', () => {
  it('maps only controls inside the window, in window-local coordinates', () => {
    const { targets } = axNodesToTargets(tree, windowA.bounds);
    const ids = targets.map((target) => target.targetId);
    expect(ids).toContain('ax:0/0/0');
    expect(ids).toContain('ax:0/1');
    expect(ids).not.toContain('ax:1/0');

    const save = targets.find((target) => target.targetId === 'ax:0/1')!;
    expect(save.tag).toBe('button');
    expect(save.actionable).toBe(true);
    expect(save.bbox).toEqual({ x: 720, y: 10, width: 70, height: 28 });
    expect(save.attributes?.axPath).toBe('0/1');
    expect(save.attributes?.actions).toBe('AXPress');

    const text = targets.find((target) => target.targetId === 'ax:0/0/0')!;
    expect(text.name).toBe('hello');
    expect(text.value).toBe('hello');
    expect(text.attributes?.axPath).toBe('0/0/0');
  });

  it('drops nameless structural nodes but keeps unnamed controls', () => {
    const nodes: AxNode[] = [
      { path: '0', role: 'AXWindow', depth: 0, x: 100, y: 80, width: 100, height: 100 },
      { path: '0/0', role: 'AXGroup', depth: 1, x: 100, y: 80, width: 100, height: 100 },
      { path: '0/1', role: 'AXButton', depth: 1, x: 100, y: 80, width: 40, height: 20 },
      { path: '0/2', role: 'AXStaticText', value: 'Status: ready', depth: 1, x: 110, y: 90, width: 60, height: 14 },
    ];
    const { targets, text } = axNodesToTargets(nodes, windowA.bounds);
    expect(targets.map((target) => target.role)).toEqual(['AXButton', 'AXStaticText']);
    expect(text).toMatch(/Status: ready/);
  });

  it('caps target count and marks the observation as truncated', () => {
    const many: AxNode[] = Array.from({ length: 30 }, (_, index) => ({
      path: `0/${index}`,
      role: 'AXButton',
      title: `Button ${index}`,
      depth: 1,
      x: 100,
      y: 80,
      width: 20,
      height: 20,
      actions: ['AXPress'],
    }));
    const result = axNodesToTargets(many, windowA.bounds, { maxTargets: 10 });
    expect(result.targets).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.textTruncated).toBe(false);
    expect(result.omitted).toBe(20);
  });
});

describe('appWindowSurfaceId', () => {
  it('is a stable per-app surface id', () => {
    expect(appWindowSurfaceId(windowA)).toBe('desktop_app:com.apple.textedit');
    expect(appWindowSurfaceId({ ...windowA, bundleId: undefined, appName: 'My App' })).toBe('desktop_app:my-app');
    expect(appWindowSurfaceId({ ...windowA, bundleId: undefined, appName: '' })).toBe('desktop_app:pid-900');
  });
});
