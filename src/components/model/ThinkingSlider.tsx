import { FiCpu, FiZap, FiCircle, FiCpu as FiDeep } from 'react-icons/fi';
import type { ReasoningEffort } from '../../types';
import { useLanguageStore } from '../../stores';

interface ThinkingSliderProps {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
}

/**
 * Codex-style thinking intensity: Auto picks depth from the request; L/M/H
 * force a budget. Auto is the default — one less decision for the user.
 */
const LEVELS: {
  value: ReasoningEffort;
  label: string;
  descKey: string;
  icon: typeof FiZap;
}[] = [
  { value: 'auto', label: 'Auto', descKey: 'effortAuto', icon: FiCpu },
  { value: 'low', label: 'L', descKey: 'effortFast', icon: FiZap },
  { value: 'medium', label: 'M', descKey: 'effortBalanced', icon: FiCircle },
  { value: 'high', label: 'H', descKey: 'effortDeep', icon: FiDeep },
];

export default function ThinkingSlider({ value, onChange }: ThinkingSliderProps) {
  const { t } = useLanguageStore();
  const index = Math.max(0, LEVELS.findIndex((l) => l.value === value));
  const n = LEVELS.length;
  // Slot-based layout: equal columns, pill tracks the same grid cells so it
  // cannot drift (translate % of the pill's own width used to misalign).
  const slot = 100 / n;

  return (
    <div className="flex items-center gap-1.5">
      <div
        className="relative grid bg-[var(--bg-3)]/80 rounded-2xl p-0.5 overflow-hidden"
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
      >
        <div
          aria-hidden
          className="absolute top-0.5 bottom-0.5 rounded-xl bg-[var(--bg-0)] shadow-sm border border-[var(--border)]/80"
          style={{
            left: `calc(${index * slot}% + 2px)`,
            width: `calc(${slot}% - 4px)`,
            transition: 'left 180ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        />
        {LEVELS.map((level) => {
          const Icon = level.icon;
          const active = value === level.value;
          return (
            <button
              key={level.value}
              onClick={() => onChange(level.value)}
              title={t(level.descKey)}
              className={`relative z-10 h-7 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors ${
                active
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Icon size={11} />
              <span>{level.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
