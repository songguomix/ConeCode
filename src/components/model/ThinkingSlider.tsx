import { useEffect, useMemo, useRef, useState } from 'react';
import { FiCpu, FiZap, FiCircle, FiLayers } from 'react-icons/fi';
import type { IconType } from 'react-icons';
import type { ReasoningEffort } from '../../types';
import { useLanguageStore, useUIStore } from '../../stores';
import { clampEffort } from '../../core/model/resolveEffort';

interface ThinkingSliderProps {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
  /** Effort levels the selected model declares. undefined → show the full ladder. */
  levels?: ReasoningEffort[];
}

const FULL_LADDER: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

const LEVEL_META: Record<ReasoningEffort, { shortKey: string; descKey: string; Icon: IconType }> = {
  auto: { shortKey: 'effortAutoShort', descKey: 'effortAuto', Icon: FiCpu },
  low: { shortKey: 'effortFast', descKey: 'effortFast', Icon: FiZap },
  medium: { shortKey: 'effortBalanced', descKey: 'effortBalanced', Icon: FiCircle },
  high: { shortKey: 'effortDeep', descKey: 'effortDeep', Icon: FiLayers },
};

// Fixed pixel geometry so drag math stays exact without measuring the DOM.
const TRACK_W = 216;
const THUMB = 16;
const SPAN = TRACK_W - THUMB;

/**
 * Codex-style thinking intensity: a collapsed pill that opens a small popup
 * with a draggable slider. Stops follow the selected model — levels it doesn't
 * declare are not shown, while Auto stays (it maps onto the declared levels at
 * send time). The deepest stop is an hourglass stopper with 流沙 running.
 */
export default function ThinkingSlider({ value, onChange, levels }: ThinkingSliderProps) {
  const { t } = useLanguageStore();
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  const stops = useMemo<ReasoningEffort[]>(() => {
    const declared = levels?.length ? new Set(levels) : null;
    const out: ReasoningEffort[] = ['auto'];
    for (const e of FULL_LADDER) if (!declared || declared.has(e)) out.push(e);
    return out;
  }, [levels]);

  useEffect(() => {
    if (!open) return;
    const handleDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // The model menu opens upward too — don't stack two popups.
    useUIStore.getState().closeModelSelector();
    thumbRef.current?.focus({ preventScroll: true });
  }, [open]);

  // A level picked under a previous model may be missing here; show the same
  // nearest level the send path will clamp to, so the UI never lies.
  const shown = value === 'auto' || stops.includes(value) ? value : clampEffort(value, stops);
  const Meta = LEVEL_META[shown];
  const n = stops.length;
  const span = Math.max(1, n - 1);
  const index = Math.max(0, stops.indexOf(shown));
  const center = (i: number) => THUMB / 2 + (i * SPAN) / span;
  const atDeepEnd = index === n - 1 && n > 1;

  const pickAt = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rel = clientX - rect.left - THUMB / 2;
    const i = Math.min(span, Math.max(0, Math.round((rel / SPAN) * span)));
    const next = stops[i];
    if (next && next !== shown) onChange(next);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    pickAt(e.clientX);
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging) pickAt(e.clientX);
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  const handleThumbKey = (e: React.KeyboardEvent) => {
    let next = index;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, index - 1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(span, index + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = span;
    else return;
    e.preventDefault();
    const stop = stops[next];
    if (stop && stop !== shown) onChange(stop);
  };

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`${t('thinkingEffort')} · ${t(Meta.descKey)}`}
        aria-label={t('thinkingEffort')}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`flex items-center h-8 pl-1.5 pr-2.5 rounded-xl border transition-colors ${
          open
            ? 'bg-[var(--bg-3)] border-[var(--accent)]/50 text-[var(--text-primary)]'
            : 'bg-[var(--bg-3)]/80 hover:bg-[var(--bg-3)] border-[var(--border)]/60 text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        {/* keyed remount → the label pops on every level change (calm while dragging) */}
        <span key={shown} className={`flex items-center gap-2 ${dragging ? '' : 'anim-pop'}`}>
          <span className="w-5 h-5 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center shrink-0">
            <Meta.Icon size={11} />
          </span>
          <span className="text-[11px] font-semibold whitespace-nowrap">{t(Meta.shortKey)}</span>
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('thinkingEffort')}
          className="absolute bottom-full right-0 mb-2 w-[260px] p-3.5 rounded-2xl bg-[var(--bg-2)]/95 backdrop-blur-xl border border-[var(--border)]/80 shadow-2xl z-50 anim-effort-pop"
          style={{
            backgroundImage: 'linear-gradient(165deg, rgba(255,255,255,0.05), transparent 45%)',
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {t('thinkingEffort')}
            </span>
            <span className="flex items-center gap-1 text-[11px] font-semibold text-[var(--accent)]">
              <Meta.Icon size={11} />
              {t(Meta.shortKey)}
            </span>
          </div>

          <div className="w-[216px] mx-auto">
            <div
              ref={trackRef}
              className="relative h-6 cursor-grab active:cursor-grabbing touch-none select-none effort-stagger-1"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              {/* rail + gradient fill */}
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-[var(--bg-4)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)]" />
              <div
                aria-hidden
                className={`absolute left-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full effort-fill ${dragging ? 'dragging' : ''}`}
                style={{
                  width: center(index),
                  backgroundImage: 'linear-gradient(90deg, var(--accent-soft), var(--accent))',
                  boxShadow: '0 0 10px -3px var(--accent)',
                }}
              />
              {/* tick dots — tint warmer as they approach the deepest stop */}
              {stops.map((stop, i) => i < n - 1 ? (
                <span
                  key={stop}
                  aria-hidden
                  className="absolute top-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-[var(--border)]"
                  style={{
                    left: center(i) - 2,
                    backgroundColor: `color-mix(in srgb, var(--accent) ${Math.round((i / span) * 70)}%, var(--border))`,
                  }}
                />
              ) : null)}
              {/* deepest stop: an hourglass stopper with 流沙 running, lit when reached */}
              {n > 1 && (
                <span
                  aria-hidden
                  className={`absolute w-3 h-5 rounded-[4px] border overflow-hidden transition-[border-color,box-shadow] duration-200 ${
                    atDeepEnd
                      ? 'border-[var(--accent)]/70 shadow-[0_0_10px_-2px_var(--accent)] effort-flip'
                      : 'border-[var(--border)]'
                  }`}
                  style={{
                    left: center(n - 1) - 6,
                    top: 'calc(50% - 10px)',
                    backgroundImage: 'linear-gradient(180deg, var(--bg-4), var(--bg-2))',
                  }}
                >
                  <span className={`sand-fall ${atDeepEnd ? 'sand-fall-hot' : ''}`} />
                </span>
              )}
              {/* knob */}
              <div
                ref={thumbRef}
                role="slider"
                tabIndex={0}
                aria-label={t('thinkingEffort')}
                aria-orientation="horizontal"
                aria-valuemin={0}
                aria-valuemax={span}
                aria-valuenow={index}
                aria-valuetext={t(Meta.shortKey)}
                onKeyDown={handleThumbKey}
                className={`absolute w-4 h-4 rounded-full bg-[var(--bg-0)] border-2 border-[var(--accent)] shadow-md ring-[3px] ring-[var(--accent-soft)] focus:outline-none focus:ring-[5px] focus:ring-[var(--accent)] effort-thumb ${dragging ? 'dragging' : ''}`}
                style={{ left: center(index) - THUMB / 2, top: 'calc(50% - 8px)' }}
              >
                <span className="absolute inset-0 m-auto w-1 h-1 rounded-full bg-[var(--accent)]" />
              </div>
            </div>

            {/* stop labels — active one becomes a soft pill that pops into place */}
            <div className="relative h-5 mt-1.5 effort-stagger-2">
              {stops.map((stop, i) => (
                <button
                  key={stop}
                  type="button"
                  onClick={() => onChange(stop)}
                  title={t(LEVEL_META[stop].descKey)}
                  aria-pressed={shown === stop}
                  className={`absolute top-0 -translate-x-1/2 rounded-full text-[10px] leading-4 whitespace-nowrap ${
                    shown === stop ? '' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                  style={{ left: center(i) }}
                >
                  <span
                    className={`inline-block px-2 py-0.5 transition-colors ${
                      shown === stop
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-semibold shadow-sm anim-pop'
                        : 'hover:bg-[var(--bg-3)]'
                    }`}
                  >
                    {t(LEVEL_META[stop].shortKey)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
