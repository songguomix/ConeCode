import { FiCpu } from 'react-icons/fi';
import type { ReasoningEffort } from '../../types';
import { useLanguageStore } from '../../stores';

interface ThinkingSliderProps {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
}

const LEVELS: { value: ReasoningEffort; label: string; descKey: string }[] = [
  { value: 'low', label: 'L', descKey: 'effortFast' },
  { value: 'medium', label: 'M', descKey: 'effortBalanced' },
  { value: 'high', label: 'H', descKey: 'effortDeep' },
];

export default function ThinkingSlider({ value, onChange }: ThinkingSliderProps) {
  const { t } = useLanguageStore();

  return (
    <div className="flex items-center gap-1.5">
      <FiCpu size={12} className="text-[var(--accent)] shrink-0" />
      <div className="flex items-center bg-[var(--bg-3)] rounded-xl overflow-hidden">
        {LEVELS.map((level) => (
          <button
            key={level.value}
            onClick={() => onChange(level.value)}
            className={`px-2 py-1 text-xs font-medium transition-colors ${
              value === level.value
                ? 'bg-[var(--accent)] text-white'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
            title={t(level.descKey)}
          >
            {level.label}
          </button>
        ))}
      </div>
    </div>
  );
}
