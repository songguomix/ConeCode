import { memo } from 'react';
import { FiBriefcase, FiArrowRight } from 'react-icons/fi';
import { useLanguageStore } from '../../stores';

interface WorkModeSuggestionCardProps {
  onSwitch: () => void;
  onDismiss: () => void;
}

function WorkModeSuggestionCard({ onSwitch, onDismiss }: WorkModeSuggestionCardProps) {
  const { t } = useLanguageStore();

  return (
    <div className="flex items-center gap-2.5 px-3.5 py-2 rounded-xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--glass-surface)_90%,transparent)] backdrop-blur-xl shadow-xs anim-message">
      <FiBriefcase size={14} className="text-[var(--accent)] shrink-0" />

      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className="text-[11.5px] font-semibold text-[var(--text-primary)] font-serif shrink-0">
          {t('workModeSuggestionTitle')}
        </span>
        <span className="text-xs text-[var(--text-secondary)] truncate hidden sm:inline" title={t('workModeSuggestionDesc')}>
          {t('workModeSuggestionDesc')}
        </span>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={onDismiss}
          className="px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] transition-colors cursor-pointer"
          title={t('keepInChat')}
        >
          {t('keepInChat')}
        </button>
        <button
          onClick={onSwitch}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] shadow-2xs transition-all active:scale-95 cursor-pointer"
        >
          <FiBriefcase size={11} />
          <span>{t('approveAndSwitchToWork') || t('switchToWorkMode')}</span>
          <FiArrowRight size={11} className="opacity-80" />
        </button>
      </div>
    </div>
  );
}

export default memo(WorkModeSuggestionCard);
