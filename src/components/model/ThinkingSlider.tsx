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
  compact?: boolean;
}

const FULL_LADDER: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

const LEVEL_META: Record<ReasoningEffort, { shortKey: string; descKey: string; Icon: IconType }> = {
  auto: { shortKey: 'effortAutoShort', descKey: 'effortAuto', Icon: FiCpu },
  low: { shortKey: 'effortFast', descKey: 'effortFast', Icon: FiZap },
  medium: { shortKey: 'effortBalanced', descKey: 'effortBalanced', Icon: FiCircle },
  high: { shortKey: 'effortDeep', descKey: 'effortDeep', Icon: FiLayers },
};

// Fixed pixel geometry so drag math stays exact. The knob is deliberately
// larger than the track: its circle then fully swallows the fill's end cap, so
// no colour leaks out around the handle — not at the far left on Auto, not at
// the far right on the deepest stop.
const TRACK_W = 216;
const TRACK_H = 32;
const THUMB = 36;
const SPAN = TRACK_W - THUMB;

/**
 * Codex-style thinking intensity: a collapsed pill that opens a small popup
 * with a draggable slider. Stops follow the selected model — levels it doesn't
 * declare are not shown, while Auto stays (it maps onto the declared levels at
 * send time). The track is one thick pill filled up to the knob, with a dot per
 * stop; the deepest stop turns it into a purple gradient with 流沙 drifting
 * through it. The level list is whatever the provider API reports for the
 * model — a level it doesn't declare is never shown, and a stored value that
 * no longer exists is corrected to the nearest declared one.
 */
export default function ThinkingSlider({ value, onChange, levels, compact = false }: ThinkingSliderProps) {
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
  }, [open]);

  // The model's declared levels come from provider metadata; a size the model
  // no longer declares must not stay stored, or the next send would ask for a
  // level the API doesn't know. Correct it to the nearest declared level.
  useEffect(() => {
    if (value === 'auto' || stops.includes(value)) return;
    onChange(clampEffort(value, stops));
  }, [value, stops, onChange]);

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
        className={`flex items-center h-8 ${compact ? 'w-8 justify-center px-0' : 'pl-1.5 pr-2.5'} rounded-full border transition-all backdrop-blur-md shadow-2xs cursor-pointer ${
          open
            ? 'bg-[var(--accent-soft)] border-[color-mix(in_srgb,var(--accent)_50%,transparent)] text-[var(--accent)] font-medium shadow-xs'
            : 'bg-[var(--glass-card)] hover:bg-[var(--bg-2)] border-[var(--glass-border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        {/* keyed remount → the label pops on every level change (calm while dragging) */}
        <span key={shown} className={`flex items-center ${compact ? 'justify-center' : 'gap-2'} ${dragging ? '' : 'anim-pop'}`}>
          <span className={`w-5 h-5 rounded-full ${compact ? '' : 'bg-[var(--accent-soft)] text-[var(--accent)]'} flex items-center justify-center shrink-0`}>
            <Meta.Icon size={compact ? 13 : 11} className={compact ? 'text-[var(--accent)]' : ''} />
          </span>
          {!compact && (
            <span className="text-[11px] font-semibold whitespace-nowrap">{t(Meta.shortKey)}</span>
          )}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('thinkingEffort')}
          className="absolute bottom-full right-0 mb-2.5 w-[260px] p-3.5 rounded-2xl bg-[var(--glass-surface)] backdrop-blur-2xl border border-[var(--glass-border)] shadow-2xl z-50 anim-effort-pop ring-1 ring-black/5 dark:ring-white/10"
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
              className="relative h-8 cursor-grab active:cursor-grabbing touch-none select-none effort-stagger-1"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              {/* Full-height pill rail: the whole bar is the control, like the
                  reference card — thick track, no hairline groove. */}
              <div className="absolute inset-0 rounded-full bg-[var(--bg-3)]" />
              {/* Fill ends one half-knob past the knob's CENTRE, so its rounded
                  cap is a true 16px semicircle tucked under the 18px knob.
                  Ending exactly at the centre made the browser clamp the cap
                  radius (a 18px-wide box cannot hold a 16px radius), and that
                  squashed ellipse poked out above/below the knob — the stray
                  colour left of the handle on Auto. */}
              <div
                aria-hidden
                className={`absolute left-0 top-0 h-full rounded-full overflow-hidden effort-fill ${dragging ? 'dragging' : ''}`}
                style={{
                  width: center(index) + TRACK_H / 2,
                  backgroundImage: atDeepEnd
                    ? 'linear-gradient(90deg, #3b2ce6 0%, #6448ff 52%, #a78bfa 100%)'
                    : 'none',
                  backgroundColor: atDeepEnd ? 'transparent' : 'var(--accent)',
                }}
              >
                {/* Deepest stop: 流沙 — grains drifting sideways along the fill. */}
                {atDeepEnd && <span aria-hidden className="effort-sand" />}
              </div>
              {/* Stop dots: pale on the filled part, faint grey on the rail. */}
              {stops.map((stop, i) => (
                <span
                  key={stop}
                  aria-hidden
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-[5px] h-[5px] rounded-full pointer-events-none"
                  style={{
                    left: center(i),
                    backgroundColor: i <= index ? 'rgba(255,255,255,0.72)' : 'color-mix(in srgb, var(--text-muted) 28%, transparent)',
                  }}
                />
              ))}
              {/* Plain white knob — the accent lives in the track, not the thumb. */}
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
                className={`absolute rounded-full bg-white ring-1 ring-black/5 shadow-[0_2px_6px_rgba(15,23,42,0.25)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_60%,transparent)] effort-thumb ${dragging ? 'dragging' : ''}`}
                style={{ left: center(index) - THUMB / 2, top: (TRACK_H - THUMB) / 2, width: THUMB, height: THUMB }}
              />
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
