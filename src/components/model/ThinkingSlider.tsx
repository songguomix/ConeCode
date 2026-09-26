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

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative flex items-center bg-[var(--bg-3)]/80 rounded-2xl p-0.5 overflow-hidden">
        {/* Sliding pill — transform/opacity only. */}
        <div
          className="absolute top-0.5 bottom-0.5 rounded-xl bg-[var(--bg-0)] shadow-sm border border-[var(--border)]/80 transition-transform duration-200"
          style={{
            width: `calc(${100 / LEVELS.length}% - 2px)`,
            transform: `translate3d(calc(${LEVELS.findIndex((l) => l.value === value) * 100}% + 1px), 0, 0)`,
            left: 0,
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
              className={`relative z-10 min-w-[36px] px-2 h-7 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors ${
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
