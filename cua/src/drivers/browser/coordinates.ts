import type { ScreenshotMeta } from '../../protocol/schemas.js';

import { CuaError } from '../../protocol/errors.js';

export interface ViewportPoint {
  x: number;
  y: number;
}

/**
 * Convert a point the model picked on the screenshot into CSS viewport pixels.
 * Screenshots can be resized (scale) and cropped (offset); both are recorded in
 * the observation so the conversion is reproducible, never guessed.
 */
export function screenshotToViewport(point: [number, number], meta: ScreenshotMeta): ViewportPoint {
  const { scaleX, scaleY, offsetX = 0, offsetY = 0 } = meta;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    throw new CuaError('PROTOCOL_INVALID', 'Screenshot metadata has an invalid scale.');
  }
  return {
    x: clamp((point[0] - offsetX) / scaleX, 0, meta.viewportWidth - 1),
    y: clamp((point[1] - offsetY) / scaleY, 0, meta.viewportHeight - 1),
  };
}

/** Inverse, for drawing target boxes or reporting where a click landed. */
export function viewportToScreenshot(point: ViewportPoint, meta: ScreenshotMeta): [number, number] {
  const { scaleX, scaleY, offsetX = 0, offsetY = 0 } = meta;
  return [
    clamp(point.x * scaleX + offsetX, 0, Math.max(0, meta.width - 1)),
    clamp(point.y * scaleY + offsetY, 0, Math.max(0, meta.height - 1)),
  ];
}

export function screenshotScale(width: number, height: number, viewportWidth: number, viewportHeight: number): { scaleX: number; scaleY: number } {
  return {
    scaleX: viewportWidth > 0 ? width / viewportWidth : 1,
    scaleY: viewportHeight > 0 ? height / viewportHeight : 1,
  };
}

export function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    throw new CuaError('DRIVER_ERROR', 'Screenshot is not a PNG.');
  }
  // IHDR width/height are big-endian uint32 at byte offsets 16 and 20.
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(min, n), Math.max(min, max));
}
