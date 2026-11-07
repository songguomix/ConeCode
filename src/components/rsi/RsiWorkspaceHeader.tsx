import { FiCpu, FiFolder, FiLayers, FiSliders, FiSquare, FiTarget, FiTerminal, FiZap } from 'react-icons/fi';
import AppIcon from '../common/AppIcon';

export type RsiWorkspaceTab = 'console' | 'direction' | 'pipeline';

interface RsiWorkspaceHeaderProps {
  t: (key: string) => string;
  activeTab: RsiWorkspaceTab;
  onTabChange: (tab: RsiWorkspaceTab) => void;
  compact: boolean;
  projectPath: string | null;
  status: string;
  running: boolean;
  busy: boolean;
  canStart: boolean;
  messageCount: number;
  hasDirection: boolean;
  activeStage: number;
  needsPermissions: boolean;
  modelName: string;
  modelTitle: string;
  onChooseModel: () => void;
  onStart: () => void;
  onStop: () => void;
}

/** Shares Work's content-column hierarchy without importing its task actions. */
export default function RsiWorkspaceHeader({
  t, activeTab, onTabChange, compact, projectPath, status, running, busy,
  canStart, messageCount, hasDirection, activeStage, needsPermissions,
  modelName, modelTitle, onChooseModel, onStart, onStop,
}: RsiWorkspaceHeaderProps) {
  const tabs = [
    { id: 'console' as const, label: t('rsiTabConsole'), icon: <FiTerminal size={13} /> },
    { id: 'direction' as const, label: t('rsiTabDirection'), icon: <FiTarget size={13} /> },
    { id: 'pipeline' as const, label: t('rsiTabPipeline'), icon: <FiLayers size={13} /> },
  ];

  return (
    <header className="max-w-[840px] mx-auto w-full pt-2 min-w-0">
      {!compact && (
        <div className="pt-2 pb-4 flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-2xl flex items-center justify-center border border-[color-mix(in_srgb,var(--accent)_20%,transparent)] shadow-xs shrink-0 overflow-hidden">
            <AppIcon size={44} className="w-full h-full object-cover" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl font-serif font-bold text-[var(--text-primary)] tracking-tight break-words">
              {t('rsiTitle')}
            </h1>
            <p className="text-[13px] text-[var(--text-muted)] mt-0.5 leading-relaxed">
              {t('rsiConvTranscriptEmpty')}
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 mb-4 px-3 py-1.5 rounded-xl bg-[var(--glass-card)] border border-[var(--glass-border)] text-xs text-[var(--text-muted)] flex-wrap shadow-2xs min-w-0">
        {compact && <h1 className="text-[13px] font-bold font-serif text-[var(--text-primary)]">{t('rsiTitle')}</h1>}
        {projectPath && (
          <span title={projectPath} className="inline-flex min-w-0 max-w-full items-center gap-1.5 font-bold text-[var(--text-primary)] font-serif text-[13px]">
            <FiFolder size={12} className="text-[var(--accent)] shrink-0" />
            <span className="truncate">{projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath}</span>
          </span>
        )}
        <span role="status" className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--accent-soft)] text-[var(--accent)] font-semibold text-[11px]">
          <span className={`w-1.5 h-1.5 rounded-full bg-current shrink-0 ${running ? 'animate-pulse' : ''}`} />
          {status}
        </span>
        <button
          type="button"
          onClick={onChooseModel}
          title={modelTitle}
          aria-label={`${t('rsiModelChange')}: ${modelName}`}
          className="ml-auto inline-flex items-center gap-1.5 min-w-0 max-w-[190px] px-1 py-0.5 rounded-md hover:text-[var(--accent)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer"
        >
          <FiCpu size={12} className="shrink-0" />
          <span className="truncate">{modelName}</span>
          <FiSliders size={11} className="shrink-0" />
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 border-b border-[var(--glass-border)] pb-3 min-w-0">
        <nav aria-label={t('rsiTitle')} className="inline-flex max-w-full min-w-0 overflow-x-auto p-1 bg-[var(--glass-card)] border border-[var(--glass-border)] rounded-xl gap-1 shadow-2xs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              aria-pressed={activeTab === tab.id}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${activeTab === tab.id
                ? 'bg-[var(--glass-surface)] text-[var(--accent)] font-bold shadow-xs border border-[var(--glass-border)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_40%,transparent)] border border-transparent'}`}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {tab.id === 'console' && messageCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-semibold">{messageCount}</span>}
              {tab.id === 'direction' && hasDirection && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />}
              {tab.id === 'pipeline' && running && <span className="text-[10px] font-mono text-[var(--accent)]">{activeStage ? `P${activeStage}` : '…'}</span>}
              {tab.id === 'pipeline' && !running && needsPermissions && <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] shrink-0" />}
            </button>
          ))}
        </nav>
        <button
          type="button"
          onClick={running ? onStop : onStart}
          disabled={!running && !canStart}
          className={`ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-white transition-colors shadow-2xs disabled:opacity-40 disabled:cursor-not-allowed shrink-0 cursor-pointer ${running
            ? 'bg-[var(--error)] hover:opacity-90'
            : 'bg-[var(--accent)] hover:bg-[var(--accent-hover)]'}`}
        >
          {running ? <FiSquare size={12} /> : <FiZap size={12} />}
          <span>{running ? t('rsiStop') : busy ? t('rsiRunning') : t('rsiStart')}</span>
        </button>
      </div>
    </header>
  );
}
