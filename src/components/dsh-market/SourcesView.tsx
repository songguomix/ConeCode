import { useState } from 'react';
import {
  FiAlertTriangle, FiClock, FiDatabase, FiExternalLink, FiFolderPlus,
  FiGlobe, FiHardDrive, FiPackage, FiRefreshCw, FiTrash2,
} from 'react-icons/fi';
import { useDshMarketStore } from '../../stores/dshMarket.store';
import { formatDateTime } from './MarketCommon';

export default function SourcesView({ t }: { t: (key: string) => string }) {
  const snapshot = useDshMarketStore((s) => s.snapshot);
  const sourceBusy = useDshMarketStore((s) => s.sourceBusy);
  const refreshSources = useDshMarketStore((s) => s.refreshSources);
  const addRemoteSource = useDshMarketStore((s) => s.addRemoteSource);
  const addLocalSource = useDshMarketStore((s) => s.addLocalSource);
  const removeSource = useDshMarketStore((s) => s.removeSource);
  const inspectLocal = useDshMarketStore((s) => s.inspectLocal);
  const restartRuntime = useDshMarketStore((s) => s.restartRuntime);
  const openExternal = useDshMarketStore((s) => s.openExternal);
  const revealPath = useDshMarketStore((s) => s.revealPath);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const sources = snapshot?.sources || [];
  const runtime = snapshot?.runtime;
  const warnings = snapshot?.warnings || [];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/65 p-4">
        <div className="flex items-center gap-2 mb-3">
          <FiDatabase size={14} className="text-[var(--accent)]" />
          <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{t('addSource')}</h3>
        </div>
        <div className="grid gap-2 md:grid-cols-[1fr_180px_auto]">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t('sourceUrlPh')}
            spellCheck={false}
            className="h-9 px-3 rounded-xl bg-[var(--bg-0)] border border-[var(--border)] text-[11px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('sourceTitlePh')}
            spellCheck={false}
            className="h-9 px-3 rounded-xl bg-[var(--bg-0)] border border-[var(--border)] text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <button
            disabled={!url.trim() || sourceBusy === 'add'}
            onClick={() => {
              void addRemoteSource(url.trim(), title.trim() || undefined).then(() => { setUrl(''); setTitle(''); });
            }}
            className="h-9 px-3 rounded-xl bg-[var(--accent)] text-white text-[11px] font-medium disabled:opacity-40 inline-flex items-center justify-center gap-1.5"
          >
            <FiGlobe size={12} />{t('addRemote')}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <button onClick={() => void addLocalSource().catch(() => {})} className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5">
            <FiHardDrive size={11} />{t('addLocal')}
          </button>
          <button onClick={() => void inspectLocal().catch(() => {})} className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5">
            <FiFolderPlus size={11} />{t('importLocal')}
          </button>
          <span className="text-[10px] text-[var(--text-muted)]">{t('reviewHint')}</span>
        </div>
      </section>

      <section className="space-y-2">
        {sources.map((source) => (
          <div key={source.id} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/60 p-3.5">
            <div className="flex items-start gap-2.5">
              <span className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${source.kind === 'bundled' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--bg-3)] text-[var(--text-secondary)]'}`}>
                {source.kind === 'bundled' ? <FiPackage size={14} /> : source.kind === 'remote' ? <FiGlobe size={14} /> : <FiHardDrive size={14} />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">{source.title}</span>
                  <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--bg-3)] text-[var(--text-muted)]">
                    {t(source.kind === 'bundled' ? 'sourceBundled' : source.kind === 'remote' ? 'sourceRemote' : 'sourceLocal')}
                  </span>
                  <span className="text-[9.5px] text-[var(--text-muted)] font-mono">{source.cachedEntries} {t('entries')}</span>
                  {source.stale && <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-amber-500/12 text-amber-600 dark:text-amber-400">{t('staleCache')}</span>}
                </div>
                <button
                  onClick={() => {
                    if (/^https?:\/\//.test(source.location)) void openExternal(source.location);
                    else void revealPath(source.location);
                  }}
                  className="mt-1 block text-left text-[10px] font-mono text-[var(--text-muted)] hover:text-[var(--accent)] break-all max-w-full"
                  title={source.location}
                >
                  {source.location} <FiExternalLink size={9} className="inline" />
                </button>
                <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-[var(--text-muted)]">
                  <span className="inline-flex items-center gap-1"><FiClock size={9} />{t('lastSync')}: {formatDateTime(source.lastSyncAt)}</span>
                  {source.lastError && (
                    <span className="inline-flex items-center gap-1 text-[var(--warning)] max-w-full"><FiAlertTriangle size={9} /><span className="break-all">{source.lastError}</span></span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  disabled={sourceBusy !== null}
                  onClick={() => void refreshSources(source.id).catch(() => {})}
                  className="w-7 h-7 rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center disabled:opacity-40"
                  title={t('sync')}
                >
                  <FiRefreshCw size={11} className={sourceBusy === source.id ? 'animate-spin' : ''} />
                </button>
                {source.kind !== 'bundled' && (
                  <button
                    onClick={() => void removeSource(source.id).catch(() => {})}
                    className="w-7 h-7 rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--error)] flex items-center justify-center"
                    title={t('removeSource')}
                  >
                    <FiTrash2 size={11} />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/60 p-4">
        <div className="flex items-center gap-2 mb-3">
          <FiPackage size={14} className="text-[var(--accent)]" />
          <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{t('runtime')}</h3>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2 text-[10.5px]">
          <Row label={t('baseline')} value={`${snapshot?.baseline.version} · ${snapshot?.baseline.commit.slice(0, 12)}`} mono />
          <Row label={t('layer')} value={snapshot?.layerVersion || '—'} mono />
          <Row label={t('environment')} value={runtime?.environment ? `Electron ${runtime.environment.electronVersion} · Node ${runtime.environment.nodeVersion} · ${runtime.environment.platform}/${runtime.environment.arch}` : '—'} mono />
          <Row label={t('npm')} value={runtime?.npmVersion ? `${runtime.npmVersion} (${runtime.npmPath})` : 'not found'} mono />
          <Row label="Worker" value={runtime?.workerPid ? `thread ${runtime.workerPid}` : '—'} mono />
          <Row label="Formats" value={runtime?.supportedFormats.join(', ') || '—'} />
          <Row label="Storage substrate" value={runtime?.storage.ready ? `${runtime.storage.backend} · ${runtime.storage.root}` : (runtime?.storage.error || 'unavailable')} mono />
        </dl>
        {runtime?.lastError && <div className="mt-2 text-[10.5px] text-[var(--error)] whitespace-pre-wrap">{runtime.lastError}</div>}
        <div className="mt-3 flex items-center gap-2">
          <button onClick={() => void restartRuntime().catch(() => {})} className="px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5">
            <FiRefreshCw size={11} />{t('runtimeRestart')}
          </button>
          <button onClick={() => void refreshSources().catch(() => {})} disabled={sourceBusy !== null} className="px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-40">
            <FiRefreshCw size={11} />{t('syncAll')}
          </button>
        </div>
      </section>

      {warnings.length > 0 && (
        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400 mb-1"><FiAlertTriangle size={11} />{t('warnings')}</div>
          <ul className="list-disc pl-4 space-y-0.5 text-[10.5px] text-[var(--text-secondary)]">
            {warnings.map((warning, index) => <li key={index} className="break-words">{warning}</li>)}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/40 p-3.5 text-[10.5px] text-[var(--text-muted)] leading-relaxed">
        <div className="font-medium text-[var(--text-secondary)] mb-1">{t('compatibilityMatrix')}</div>
        <p>{t('declaredVsActual')} — {snapshot?.baseline.repository}</p>
        <p className="mt-1 font-mono break-all">{snapshot?.baseline.references.join(' · ')}</p>
      </section>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">{label}</dt>
      <dd className={`text-[10.5px] text-[var(--text-secondary)] break-all ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
