import { FiArrowRight, FiCheckSquare, FiMonitor, FiShield, FiTarget } from 'react-icons/fi';
import type { RsiDirectionConfig } from '../../core/agents/rsiConversation';
import type { RsiWorkspaceTab } from './RsiWorkspaceHeader';

interface RsiWelcomeProps {
  t: (key: string) => string;
  direction: RsiDirectionConfig | null;
  screenStatus: string;
  accessibilityStatus: string;
  onTabChange: (tab: RsiWorkspaceTab) => void;
}

/** Only presents this RSI session's recorded configuration and live readiness. */
export default function RsiWelcome({ t, direction, screenStatus, accessibilityStatus, onTabChange }: RsiWelcomeProps) {
  const cards = [
    { key: 'objective', title: t('rsiDirectionObjective'), body: direction?.objective?.trim() || t('rsiNoDirectionConfigured'), icon: <FiTarget size={14} />, tab: 'direction' as const },
    { key: 'metrics', title: t('rsiDirectionMetrics'), body: direction?.metrics?.trim() || t('rsiDirectionMetricsHint'), icon: <FiCheckSquare size={14} />, tab: 'direction' as const },
    { key: 'constraints', title: t('rsiDirectionConstraints'), body: direction?.constraints?.trim() || direction?.scope?.trim() || t('rsiDirectionConstraintsHint'), icon: <FiShield size={14} />, tab: 'direction' as const },
    { key: 'readiness', title: t('rsiPreflightTitle'), body: `${t('rsiScreenStatus')}: ${screenStatus}\n${t('rsiAccessibilityStatus')}: ${accessibilityStatus}`, icon: <FiMonitor size={14} />, tab: 'pipeline' as const },
  ];

  return (
    <section aria-label={t('rsiConvTranscript')} className="max-w-[840px] mx-auto w-full pb-6 min-w-0 anim-message">
      <div className="rsi-welcome-grid">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={() => onTabChange(card.tab)}
            className="group text-left rounded-xl border border-[var(--glass-border)] bg-[var(--glass-card)] hover:bg-[var(--glass-surface)] p-4 hover:border-[color-mix(in_srgb,var(--accent)_50%,transparent)] hover:shadow-[0_4px_16px_rgba(201,100,66,0.06)] transition-colors flex flex-col gap-2 min-h-[110px] min-w-0 overflow-hidden shadow-2xs cursor-pointer"
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <span className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center bg-[var(--accent-soft)] text-[var(--accent)]">{card.icon}</span>
              <span className="text-[15px] font-bold text-[var(--text-primary)] font-serif leading-snug flex-1 min-w-0 break-words">{card.title}</span>
              <FiArrowRight size={13} className="shrink-0 mt-0.5 text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors" />
            </div>
            <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed whitespace-pre-line line-clamp-2 break-words [overflow-wrap:anywhere]">{card.body}</p>
            <span className="mt-auto pt-1 text-[11px] text-[var(--text-muted)]">{t(card.tab === 'direction' ? 'rsiTabDirection' : 'rsiTabPipeline')}</span>
          </button>
        ))}
      </div>
      <p className="mt-4 text-xs text-[var(--text-muted)] leading-relaxed">{t('rsiConvTranscriptSub')}</p>
    </section>
  );
}
