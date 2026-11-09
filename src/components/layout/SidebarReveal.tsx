import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { FiMenu } from 'react-icons/fi';
import './sidebar-reveal.css';

/** Exit animation length in `sidebar-reveal.css`; the timer below is a fallback. */
const EXIT_MS = 260;

/** Layout-only choreography; the caller owns sidebar state and content. */
export default function SidebarReveal({ open, width, overlay, label, onToggle, children }: {
  open: boolean;
  width: number;
  overlay: boolean;
  label: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const [present, setPresent] = useState(open);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /** Only pull focus into the sidebar when it was opened from the keyboard. */
  const fromKeyboard = useRef(false);

  const focusPanel = () => {
    const first = panel.current?.querySelector<HTMLButtonElement>('button:not([disabled])');
    if (first && first.offsetParent !== null) first.focus({ preventScroll: true });
    else panel.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    // Restore focus before making the outgoing sidebar inert.
    if (panel.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    // Keep content alive for the exit, including when an animation is cancelled.
    const timer = window.setTimeout(() => setPresent(false), EXIT_MS + 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  useLayoutEffect(() => {
    if (panel.current) panel.current.inert = !open;
    if (!open || !present) return;
    if (!fromKeyboard.current || document.activeElement !== trigger.current) return;
    fromKeyboard.current = false;
    focusPanel();
  }, [open, present]);

  return (
    <>
      {overlay && present && (
        <button className="sidebar-reveal-scrim" data-open={open} onClick={onToggle}
          aria-hidden="true" tabIndex={-1} />
      )}
      <div className="sidebar-reveal-slot" data-open={open} data-overlay={overlay}
        style={{ '--sidebar-reveal-width': `${width}px` } as CSSProperties}>
        <div id={id} ref={panel} className="sidebar-reveal-panel" aria-hidden={!open} tabIndex={-1}
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget) return;
            if (!open) setPresent(false);
          }}>
          {present && children}
        </div>
      </div>
      <div className="sidebar-trigger-anchor" data-open={open}>
        <button ref={trigger} onClick={() => {
          fromKeyboard.current = trigger.current?.matches(':focus-visible') ?? false;
          onToggle();
        }} title={label} aria-label={label}
          aria-expanded={open} aria-controls={id} tabIndex={open ? -1 : 0}
          className="sidebar-reveal-trigger glass-dock">
          <FiMenu size={17} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
