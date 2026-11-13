import type { ComputerTarget, DisplayGeometry } from '../../src/core/computer/computer';

export interface NativeWindow extends ComputerTarget {
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function sameWindow(a: NativeWindow, b: NativeWindow): boolean {
  return a.id === b.id && a.pid === b.pid;
}

export function sameWindowBounds(a: NativeWindow, b: NativeWindow): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function publicTarget({ id, pid, name, title }: NativeWindow): ComputerTarget {
  // A native window handle can be reused after its original owner exits.
  return { id: `${pid}:${id}`, name, title };
}

export function windowPoint(
  coordinate: [number, number], geometry: DisplayGeometry, target: NativeWindow,
): { x: number; y: number } {
  const [x, y] = coordinate;
  if (x >= geometry.captureWidth || y >= geometry.captureHeight) {
    throw new Error('The point is outside the selected app screenshot.');
  }
  return {
    x: target.x + Math.floor(x * target.width / geometry.captureWidth),
    y: target.y + Math.floor(y * target.height / geometry.captureHeight),
  };
}

export function capturePoint(point: {x: number; y: number}, geometry: DisplayGeometry, target: NativeWindow): [number, number] | null {
  const x = point.x - target.x;
  const y = point.y - target.y;
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return null;
  return [Math.floor(x * geometry.captureWidth / target.width), Math.floor(y * geometry.captureHeight / target.height)];
}
