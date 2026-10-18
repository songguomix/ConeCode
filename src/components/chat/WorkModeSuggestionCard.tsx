import { memo } from 'react';
import { FiBriefcase, FiArrowRight, FiX } from 'react-icons/fi';
import { useLanguageStore } from '../../stores';

interface WorkModeSuggestionCardProps {
  onSwitch: () => void;
  onDismiss: () => void;
}

function WorkModeSuggestionCard({ onSwitch, onDismiss }: WorkModeSuggestionCardProps) {
  const { t } = useLanguageStore();

  return (
    <div className="relative group overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-surface)] backdrop-blur-xl p-3.5 sm:p-4 shadow-xl ring-1 ring-black/5 dark:ring-white/10 anim-card">
      {/* Subtle accent gradient glow */}
      <div className="absolute -top-12 -right-12 w-32 h-32 bg-[var(--accent)]/10 rounded-full blur-2xl pointer-events-none" />

      <div className="flex items-start sm:items-center justify-between gap-3 min-w-0">
        <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
          <div className="w-9 h-9 rounded-xl bg-[var(--accent-soft)] flex items-center justify-center text-[var(--accent)] shrink-0 shadow-2xs">
            <FiBriefcase size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-[13px] sm:text-[14px] font-semibold text-[var(--text-primary)] font-serif tracking-tight truncate">
              {t('workModeSuggestionTitle')}
            </h4>
            <p className="text-[11.5px] sm:text-[12px] text-[var(--text-secondary)] mt-0.5 leading-snug">
              {t('workModeSuggestionDesc')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
          <button
            onClick={onDismiss}
            className="px-2.5 py-1.5 rounded-xl text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)]/60 transition-all border border-transparent hover:border-[var(--glass-border)]"
            title={t('keepInChat')}
          >
            {t('keepInChat')}
          </button>
          <button
            onClick={onSwitch}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] shadow-xs transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <FiBriefcase size={12} />
            <span>{t('approveAndSwitchToWork') || t('switchToWorkMode')}</span>
            <FiArrowRight size={12} className="opacity-80" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(WorkModeSuggestionCard);
