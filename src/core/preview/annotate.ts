// Shared UI store pieces for annotate-to-chat (pure helpers + types).
// Coordinates are normalized 0–1 over the preview frame so they survive resizes.

export interface AnnotatePin {
  id: string;
  /** 0–1 across the frame width. */
  x: number;
  /** 0–1 down the frame height. */
  y: number;
  label: string;
}

export function formatPinPrompt(pin: AnnotatePin, extra?: string): string {
  const xPct = Math.round(pin.x * 1000) / 10;
  const yPct = Math.round(pin.y * 1000) / 10;
  const base = `[预览标注 ${pin.label} · 约 ${xPct}% × ${yPct}%，相对预览画布]`;
  return extra?.trim() ? `${base} ${extra.trim()}` : `${base} 请针对这一点做精准修改。`;
}

/** Place a pin from a pointer event over the frame element. */
export function pinFromPointer(
  e: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  label = '点',
): Omit<AnnotatePin, 'id'> | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y, label };
}

export function nextPinLabel(existing: number): string {
  return `点${existing + 1}`;
}
