import { useEffect, useRef } from 'react';

/** Pointer capture also finishes a resize when the pointer leaves the window. */
export default function ResizeHandle({ label, value, min, max, reset, onChange, className, horizontal = false, sign = 1, unitsPerPixel = 1 }: {
  label: string; value: number; min: number; max: number; reset: number;
  onChange: (value: number) => void; className: string; horizontal?: boolean;
  sign?: number; unitsPerPixel?: number | (() => number);
}) {
  const drag = useRef<{
    pointerId: number; position: number; value: number; scale: number;
    cursor: string; select: string; frame: number | null; pending: number; applied: number;
  } | null>(null);
  const scale = () => typeof unitsPerPixel === 'function' ? unitsPerPixel() : unitsPerPixel;
  const flush = () => {
    const current = drag.current;
    if (!current || current.pending === current.applied) return;
    current.applied = current.pending;
    onChange(current.pending);
  };
  const finish = () => {
    if (!drag.current) return;
    if (drag.current.frame !== null) cancelAnimationFrame(drag.current.frame);
    flush();
    document.body.style.cursor = drag.current.cursor;
    document.body.style.userSelect = drag.current.select;
    drag.current = null;
  };
  useEffect(() => {
    window.addEventListener('blur', finish);
    return () => { window.removeEventListener('blur', finish); finish(); };
  }, []);
  const apply = (next: number) => onChange(Math.min(max, Math.max(min, next)));

  return (
    <div
      role="separator" tabIndex={0} aria-label={label}
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max}
      title={label} className={`group ${className}`} style={{ touchAction: 'none' }}
      onDoubleClick={() => apply(reset)}
      onKeyDown={(event) => {
        const decrease = horizontal ? 'ArrowUp' : 'ArrowLeft';
        const increase = horizontal ? 'ArrowDown' : 'ArrowRight';
        if (![decrease, increase, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        apply(event.key === 'Home' ? min : event.key === 'End' ? max : value + (event.key === increase ? 1 : -1) * sign * (event.shiftKey ? 40 : 10) * scale());
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId, position: horizontal ? event.clientY : event.clientX,
          value, scale: scale(), cursor: document.body.style.cursor, select: document.body.style.userSelect,
          frame: null, pending: value, applied: value,
        };
        document.body.style.cursor = horizontal ? 'row-resize' : 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || event.pointerId !== current.pointerId) return;
        const delta = (horizontal ? event.clientY : event.clientX) - current.position;
        current.pending = Math.min(max, Math.max(min, current.value + delta * sign * current.scale));
        if (current.frame === null && current.pending !== current.applied) {
          current.frame = requestAnimationFrame(() => {
            current.frame = null;
            flush();
          });
        }
      }}
      onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) finish(); }}
      onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) finish(); }}
      onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) finish(); }}
    >
      <div className={`${horizontal ? 'h-px w-full' : 'w-px h-full'} bg-[var(--border)] group-hover:bg-[var(--accent)] group-focus-visible:bg-[var(--accent)] transition-colors`} />
    </div>
  );
}
