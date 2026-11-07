import { useEffect, useRef } from 'react';

/** Pointer capture also finishes a resize when the pointer leaves the window. */
export default function ResizeHandle({ label, value, min, max, reset, onChange, className, horizontal = false, sign = 1, unitsPerPixel = 1 }: {
  label: string; value: number; min: number; max: number; reset: number;
  onChange: (value: number) => void; className: string; horizontal?: boolean;
  sign?: number; unitsPerPixel?: number | (() => number);
}) {
  const drag = useRef<{ position: number; value: number; scale: number; cursor: string; select: string } | null>(null);
  const scale = () => typeof unitsPerPixel === 'function' ? unitsPerPixel() : unitsPerPixel;
  const finish = () => {
    if (!drag.current) return;
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
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { position: horizontal ? event.clientY : event.clientX, value, scale: scale(), cursor: document.body.style.cursor, select: document.body.style.userSelect };
        document.body.style.cursor = horizontal ? 'row-resize' : 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      onPointerMove={(event) => {
        if (drag.current) apply(drag.current.value + ((horizontal ? event.clientY : event.clientX) - drag.current.position) * sign * drag.current.scale);
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    >
      <div className={`${horizontal ? 'h-px w-full' : 'w-px h-full'} bg-[var(--border)] group-hover:bg-[var(--accent)] group-focus-visible:bg-[var(--accent)] transition-colors`} />
    </div>
  );
}
