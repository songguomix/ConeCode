import { useEffect, useRef, useState } from 'react';
import { FiLayers, FiTarget, FiList, FiZap, FiCheck } from 'react-icons/fi';
import type { IconType } from 'react-icons';
import type { AgentMode } from '../../core/agents/modePrompts';
import { useLanguageStore, useUIStore } from '../../stores';

interface ModeSwitchProps {
  value: AgentMode;
  onChange: (mode: AgentMode) => void;
}

const MODE_META: Record<AgentMode, { shortKey: string; labelKey: string; hintKey: string; Icon: IconType }> = {
  standard: { shortKey: 'agentModeStandard', labelKey: 'agentModeStandard', hintKey: 'agentModeStandardHint', Icon: FiLayers },
  goal: { shortKey: 'agentModeGoal', labelKey: 'agentModeGoal', hintKey: 'agentModeGoalHint', Icon: FiTarget },
  orchestrate: { shortKey: 'modeOrchestrate', labelKey: 'agentModeOrchestrate', hintKey: 'agentModeOrchestrateHint', Icon: FiList },
  rsi: { shortKey: 'modeRsi', labelKey: 'agentModeRsi', hintKey: 'agentModeRsiHint', Icon: FiZap },
};

const ORDER: AgentMode[] = ['standard', 'goal', 'orchestrate', 'rsi'];

/**
 * ThinkingSlider-style agent mode switch: a collapsed pill next to the model
 * row that opens a small upward popup with the four modes. Replaces the old
 * mode rows buried in the + menu — one tap, no menu diving.
 */
export default function ModeSwitch({ value, onChange }: ModeSwitchProps) {
  const { t } = useLanguageStore();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
    // Same upward space as the model menu and the effort popup — one at a time.
    useUIStore.getState().closeModelSelector();
  }, [open ]);

  const Meta = MODE_META[value];
  const active = value !== 'standard';

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
        title={`${t('modeMenu')} · ${t(Meta.labelKey)}`}
        aria-label={t('modeMenu')}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`flex items-center h-8 pl-1.5 pr-2.5 rounded-xl border transition-colors ${
          open || active
            ? 'bg-[var(--accent-soft)] border-[var(--accent)]/50 text-[var(--accent)]'
            : 'bg-[var(--bg-3)]/80 hover:bg-[var(--bg-3)] border-[var(--border)]/60 text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        {/* keyed remount → the label pops on every mode change */}
        <span key={value} className="flex items-center gap-2 anim-pop">
          <span className="w-5 h-5 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center shrink-0">
            <Meta.Icon size={11} />
          </span>
          <span className="text-[11px] font-semibold whitespace-nowrap">{t(Meta.shortKey)}</span>
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('modeMenu')}
          className="absolute bottom-full right-0 mb-2 w-[200px] p-1.5 rounded-2xl bg-[var(--bg-2)]/95 backdrop-blur-xl border border-[var(--border)]/80 shadow-2xl z-50 anim-effort-pop"
          style={{
            backgroundImage: 'linear-gradient(165deg, rgba(255,255,255,0.05), transparent 45%)',
          }}
        >
          <div className="px-2 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {t('modeMenu')}
          </div>
          {ORDER.map((mode, i) => {
            const m = MODE_META[mode];
            const selected = value === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => { onChange(mode); setOpen(false); }}
                aria-pressed={selected}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left transition-colors effort-stagger-${Math.min(i + 1, 2)} ${
                  selected
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'hover:bg-[var(--bg-3)] text-[var(--text-primary)]'
                }`}
              >
                <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                  selected ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-3)] text-[var(--text-secondary)]'
                }`}>
                  <m.Icon size={13} />
                </span>
                <span className="flex-1 min-w-0 text-[13px] font-medium truncate">
                  {t(m.labelKey)}
                </span>
                {selected && <FiCheck size={14} className="text-[var(--accent)] shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
