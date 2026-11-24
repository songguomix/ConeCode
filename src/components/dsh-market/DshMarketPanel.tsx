import { useEffect } from 'react';
import { FiAlertCircle, FiCheckCircle, FiDatabase, FiPackage, FiRefreshCw, FiSettings, FiX } from 'react-icons/fi';
import { useDshMarketStore } from '../../stores/dshMarket.store';
import { useLanguageStore } from '../../stores';
import { marketText } from './marketI18n';
import DiscoverView from './DiscoverView';
import InstalledView from './InstalledView';
import SourcesView from './SourcesView';
import PluginDetailView from './PluginDetailView';
import './dsh-market.css';

export default function DshMarketPanel() {
  const open = useDshMarketStore((s) => s.open);
  const tab = useDshMarketStore((s) => s.tab);
  const snapshot = useDshMarketStore((s) => s.snapshot);
  const error = useDshMarketStore((s) => s.error);
  const notice = useDshMarketStore((s) => s.notice);
  const selectedPluginId = useDshMarketStore((s) => s.selectedPluginId);
  const setTab = useDshMarketStore((s) => s.setTab);
  const closePanel = useDshMarketStore((s) => s.closePanel);
  const clearSelection = useDshMarketStore((s) => s.clearSelection);
  const refreshSources = useDshMarketStore((s) => s.refreshSources);
  const sourceBusy = useDshMarketStore((s) => s.sourceBusy);
  const clearError = useDshMarketStore((s) => s.clearError);
  const pushNotice = useDshMarketStore((s) => s.pushNotice);
  const locale = useLanguageStore((s) => s.locale);
  const t = (key: string) => marketText(locale, key);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (selectedPluginId) clearSelection();
        else closePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, selectedPluginId, clearSelection, closePanel]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => pushNotice(null), 4200);
    return () => clearTimeout(timer);
  }, [notice, pushNotice]);

  if (!open) return null;

  const tabs = [
    { id: 'discover' as const, label: t('discover'), icon: <FiPackage size={13} />, count: snapshot?.catalog.total },
    { id: 'installed' as const, label: t('installed'), icon: <FiSettings size={13} />, count: snapshot?.installed.length },
    { id: 'sources' as const, label: t('sources'), icon: <FiDatabase size={13} />, count: snapshot?.sources.length },
  ];

  const activeServices = snapshot?.runtime.supportedServices.length ?? 0;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-2 sm:p-4 bg-black/40 backdrop-blur-sm" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closePanel();
    }}>
      <div role="dialog" aria-modal="true" aria-label={t('title')}
        className="dsh-market-panel w-[min(1260px,calc(100vw-16px))] h-[min(94vh,920px)] rounded-2xl border border-[var(--dm-border)] flex flex-col overflow-hidden">
        <header className="shrink-0 px-5 pt-4 pb-3 border-b border-[var(--dm-border)] bg-[var(--dm-canvas)]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg border border-[var(--dm-border)] bg-[var(--dm-surface)] text-[var(--dm-accent)] flex items-center justify-center shrink-0">
              <FiPackage size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-[16px] font-semibold tracking-[-0.02em] text-[var(--text-primary)] truncate">{t('title')}</h1>
                {snapshot && (
                  <span className="dm-num text-[10px] font-mono px-1.5 py-0.5 rounded-md border border-[var(--dm-border)] bg-[var(--dm-surface)] text-[var(--text-muted)]">
                    DSH {snapshot.baseline.version} · {activeServices} {t('hostServicesReady')}
                  </span>
                )}
                {snapshot?.offline && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/12 text-amber-600 dark:text-amber-400">{t('offline')}</span>}
              </div>
              <p className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">{t('subtitle')}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button disabled={sourceBusy !== null} onClick={() => void refreshSources()} title={t('sync')}
                className="w-8 h-8 rounded-lg border border-[var(--dm-border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--dm-surface)] flex items-center justify-center transition-colors">
                <FiRefreshCw size={13} className={sourceBusy !== null ? 'animate-spin' : ''} />
              </button>
              <button onClick={closePanel} title={t('close')} aria-label={t('close')}
                className="w-8 h-8 rounded-lg border border-[var(--dm-border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--dm-surface)] flex items-center justify-center transition-colors">
                <FiX size={15} />
              </button>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-1">
            {tabs.map((item) => (
              <button key={item.id}
                onClick={() => setTab(item.id)}
                className={`px-3 py-1.5 rounded-lg text-[11.5px] inline-flex items-center gap-1.5 border transition-colors ${tab === item.id && !selectedPluginId ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)] font-medium' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--dm-surface)]'}`}>
                {item.icon}{item.label}
                {item.count !== undefined && <span className="dm-num text-[10px] opacity-65 font-mono">{item.count}</span>}
              </button>
            ))}
          </div>
        </header>

        {error && (
          <div className="shrink-0 mx-5 mt-2.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-400 flex items-start gap-2">
            <FiAlertCircle size={13} className="mt-0.5 shrink-0" />
            <span className="flex-1 whitespace-pre-wrap break-words">{error}</span>
            <button onClick={clearError} className="shrink-0 p-0.5 rounded hover:bg-red-500/10"><FiX size={12} /></button>
          </div>
        )}

        <main className="flex-1 min-h-0 flex flex-col">
          {selectedPluginId ? <PluginDetailView t={t} /> : tab === 'discover' ? <DiscoverView t={t} /> : tab === 'installed' ? <InstalledView t={t} /> : <SourcesView t={t} />}
        </main>

        {notice && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-[var(--dm-elevated)] border border-[var(--dm-border)] shadow-xl px-3.5 py-2 text-[11px] text-[var(--text-secondary)] flex items-center gap-2 max-w-[80%]">
            <FiCheckCircle size={12} className="text-[var(--success)] shrink-0" />
            <span className="truncate">{notice}</span>
          </div>
        )}
      </div>
    </div>
  );
}
