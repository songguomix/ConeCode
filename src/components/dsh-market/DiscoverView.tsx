import { FiChevronDown, FiChevronLeft, FiChevronRight, FiDownload, FiGitBranch, FiRefreshCw, FiSearch, FiX } from 'react-icons/fi';
import { useState } from 'react';
import semver from 'semver';
import { useDshMarketStore } from '../../stores/dshMarket.store';
import { useLanguageStore } from '../../stores';
import type { CatalogPage } from '../../core/dsh-market/types';
import { CompatBadge, PluginIcon, SourceBadge, formatNumber } from './MarketCommon';
import RepositoryImportDialog from './RepositoryImportDialog';

export default function DiscoverView({ t }: { t: (key: string) => string }) {
  const snapshot = useDshMarketStore((s) => s.snapshot);
  const loading = useDshMarketStore((s) => s.loading);
  const query = useDshMarketStore((s) => s.query);
  const category = useDshMarketStore((s) => s.category);
  const label = useDshMarketStore((s) => s.label);
  const sort = useDshMarketStore((s) => s.sort);
  const page = useDshMarketStore((s) => s.page);
  const compatibleOnly = useDshMarketStore((s) => s.compatibleOnly);
  const compatFilter = useDshMarketStore((s) => s.compatFilter);
  const formatFilter = useDshMarketStore((s) => s.formatFilter);
  const localPreview = useDshMarketStore((s) => s.localPreview);
  const setQuery = useDshMarketStore((s) => s.setQuery);
  const setCategory = useDshMarketStore((s) => s.setCategory);
  const setLabel = useDshMarketStore((s) => s.setLabel);
  const setSort = useDshMarketStore((s) => s.setSort);
  const setPage = useDshMarketStore((s) => s.setPage);
  const setCompatibleOnly = useDshMarketStore((s) => s.setCompatibleOnly);
  const setCompatFilter = useDshMarketStore((s) => s.setCompatFilter);
  const setFormatFilter = useDshMarketStore((s) => s.setFormatFilter);
  const refreshSources = useDshMarketStore((s) => s.refreshSources);
  const sourceBusy = useDshMarketStore((s) => s.sourceBusy);
  const selectPlugin = useDshMarketStore((s) => s.selectPlugin);
  const install = useDshMarketStore((s) => s.install);
  const installLocal = useDshMarketStore((s) => s.installLocal);
  const clearLocalPreview = useDshMarketStore((s) => s.clearLocalPreview);
  const locale = useLanguageStore((s) => s.locale);
  const [repoOpen, setRepoOpen] = useState(false);

  const catalog = snapshot?.catalog;
  const totalPages = catalog ? Math.max(1, Math.ceil(catalog.total / catalog.pageSize)) : 1;
  const categories = (catalog?.categories || []).filter((item) => item.count > 0 || item.id === category);
  const labels = (catalog?.labels || []).slice(0, 12);
  const [allowScripts, setAllowScripts] = useState(false);
  const [acceptRisk, setAcceptRisk] = useState(false);
  const [installingLocal, setInstallingLocal] = useState(false);
  const requiresRisk = localPreview?.compatibility.state === 'incompatible';

  if (!snapshot && loading) {
    return <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">{t('loading')}</div>;
  }

  const totalCategoryCount = categories.reduce((total, item) => total + item.count, 0);

  return (
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
      <aside className="shrink-0 lg:w-[224px] border-b lg:border-b-0 lg:border-r border-[var(--dm-border)] bg-[var(--dm-surface)]/45 px-4 py-3.5 overflow-y-auto space-y-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">{t('category')}</div>
          <div className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible pb-1 lg:pb-0">
            <button onClick={() => setCategory('all')}
              className={`shrink-0 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[11.5px] border transition-colors ${category === 'all' ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)] font-medium' : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--dm-elevated)]'}`}>
              <span className="truncate">{t('all')}</span>
              <span className="dm-num text-[10px] font-mono opacity-65">{totalCategoryCount}</span>
            </button>
            {categories.map((item) => (
              <button key={item.id} onClick={() => setCategory(item.id)}
                className={`shrink-0 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[11.5px] border transition-colors ${category === item.id ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)] font-medium' : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--dm-elevated)]'}`}>
                <span className="truncate">{locale === 'zh' || locale === 'zhHant' ? item.title.zh : item.title.en}</span>
                <span className="dm-num text-[10px] font-mono opacity-65">{item.count}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="hidden lg:block border-t border-[var(--dm-border)] pt-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">{t('filterCompat')}</div>
          <div className="flex flex-col gap-1">
            {([
              ['all', t('all')],
              ['verified', t('verified')],
              ['partial', t('partial')],
              ['unverified', t('unverified')],
              ['client', t('filterClientUi')],
            ] as const).map(([id, textLabel]) => (
              <button key={id} onClick={() => setCompatFilter(id)}
                className={`text-left px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${compatFilter === id ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)] font-medium' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--dm-elevated)]'}`}>
                {textLabel}
              </button>
            ))}
          </div>
        </div>

        <div className="hidden lg:block border-t border-[var(--dm-border)] pt-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">{t('filterFormat')}</div>
          <div className="flex flex-col gap-1">
            {([
              ['all', t('formatAll')],
              ['dsh', t('formatDsh')],
              ['native', t('formatNative')],
            ] as const).map(([id, textLabel]) => (
              <button key={id} onClick={() => setFormatFilter(id)}
                className={`text-left px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${formatFilter === id ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)] font-medium' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--dm-elevated)]'}`}>
                {textLabel}
              </button>
            ))}
          </div>
        </div>

        {labels.length > 0 && (
          <div className="hidden lg:block border-t border-[var(--dm-border)] pt-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">{t('tags')}</div>
            <div className="flex flex-wrap gap-1">
              {labels.map((item) => (
                <button key={item.id} onClick={() => setLabel(item.id)}
                  className={`px-2 py-0.5 rounded-md text-[10px] border transition-colors ${label === item.id ? 'bg-[var(--dm-accent)] text-white border-[var(--dm-accent)]' : 'bg-transparent text-[var(--text-muted)] border-[var(--dm-border)] hover:text-[var(--text-primary)]'}`}>
                  #{item.id} <span className="dm-num opacity-60">{item.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>

      <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        <div className="sticky top-0 z-10 bg-[var(--dm-canvas)]/95 backdrop-blur-md border-b border-[var(--dm-border)] px-5 py-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <FiSearch size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('searchPh')}
              spellCheck={false}
              autoFocus
              className="w-full pl-9 pr-8 py-2 rounded-lg bg-[var(--dm-surface)] border border-[var(--dm-border)] text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--dm-accent)]"
            />
            {query && (
              <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]" title={t('all')}>
                <FiX size={12} />
              </button>
            )}
          </div>
          <div className="relative shrink-0">
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as any)}
              aria-label={t('sort')}
              className="h-8 pl-2.5 pr-7 rounded-lg bg-[var(--dm-surface)] border border-[var(--dm-border)] text-[11.5px] text-[var(--text-secondary)] outline-none focus:border-[var(--dm-accent)] appearance-none cursor-pointer"
            >
              <option value="relevance">{t('sortRelevance')}</option>
              <option value="name">{t('sortName')}</option>
              <option value="updated">{t('sortUpdated')}</option>
              <option value="downloads">{t('sortDownloads')}</option>
              <option value="stars">{t('sortStars')}</option>
            </select>
            <FiChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-muted)]" />
          </div>
          <label className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-[var(--dm-surface)] border border-[var(--dm-border)] text-[11px] text-[var(--text-secondary)] cursor-pointer select-none">
            <input type="checkbox" checked={compatibleOnly} onChange={(event) => setCompatibleOnly(event.target.checked)} className="accent-[var(--accent)]" />
            {t('compatibleOnly')}
          </label>
          <button onClick={() => setRepoOpen(true)} title={t('importRepo')}
            className="h-8 px-2.5 rounded-lg border border-[var(--dm-border)] bg-[var(--dm-surface)] text-[var(--text-secondary)] hover:text-[var(--accent)] inline-flex items-center gap-1.5 text-[11px] transition-colors">
            <FiGitBranch size={12} />{t('importRepo')}
          </button>
          <button disabled={sourceBusy !== null} onClick={() => void refreshSources()} title={t('sync')} className="w-8 h-8 rounded-lg border border-[var(--dm-border)] bg-[var(--dm-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors">
            <FiRefreshCw size={12} className={sourceBusy !== null ? 'animate-spin' : ''} />
          </button>
          <span className="dm-num text-[10.5px] font-mono text-[var(--text-muted)] ml-auto">
            {catalog?.total ?? 0} {t('results')}
          </span>
        </div>

        <div className="px-5 py-4 space-y-3">
          {localPreview && (
            <div className="rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)]/35 p-3.5">
              <div className="flex items-start gap-3">
                <PluginIcon plugin={localPreview.plugin} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{localPreview.plugin.title}</span>
                    <span className="dm-num text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-muted)] font-mono">local · {localPreview.plugin.name}@{localPreview.version.version}</span>
                    <CompatBadge state={localPreview.compatibility.state}>{t(localPreview.compatibility.state)}</CompatBadge>
                  </div>
                  <p className="dm-prose mt-1 text-[11.5px] text-[var(--text-secondary)] whitespace-pre-wrap">{localPreview.plugin.description || t('noDescription')}</p>
                  <p className="mt-1 text-[10px] text-[var(--text-muted)]">{t('localImportHint')}</p>
                  {requiresRisk && (
                    <label className="mt-2 flex items-start gap-1.5 text-[10.5px] text-[var(--warning)]">
                      <input type="checkbox" checked={acceptRisk} onChange={(event) => setAcceptRisk(event.target.checked)} />
                      <span>{localPreview.compatibility.reasons.map((reason) => reason.message).join(' · ')} {t('riskBody')}</span>
                    </label>
                  )}
                  {localPreview.plugin.format === 'dsh' && (
                    <label title={t('scriptsHint')} className="mt-2 flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
                      <input type="checkbox" checked={allowScripts} onChange={(event) => setAllowScripts(event.target.checked)} />
                      {t('allowScripts')}
                    </label>
                  )}
                  {localPreview.warnings.length > 0 && (
                    <div className="mt-1.5 text-[10px] text-[var(--warning)] whitespace-pre-wrap">
                      <span className="font-medium">{t('localWarnings')}: </span>{localPreview.warnings.join(' · ')}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <button disabled={installingLocal || (requiresRisk && !acceptRisk)} onClick={() => {
                    setInstallingLocal(true);
                    void installLocal(acceptRisk, allowScripts).catch(() => {}).finally(() => setInstallingLocal(false));
                  }} className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)]">
                    {installingLocal ? t('installing') : t('localInstall')}
                  </button>
                  <button disabled={installingLocal} onClick={clearLocalPreview} className="px-3 py-1.5 rounded-lg border border-[var(--dm-border)] text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                    {t('cancel')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {loading && !catalog && <p className="text-xs text-[var(--text-muted)]">{t('loading')}</p>}
          {catalog && catalog.items.length === 0 && (
            <div className="py-16 text-center text-sm text-[var(--text-muted)]">{t('empty')}</div>
          )}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {catalog?.items.map((plugin) => (
              <PluginCard key={plugin.name} plugin={plugin} t={t}
                onOpen={() => void selectPlugin(plugin.name).catch(() => {})}
                onInstall={() => {
                  const version = plugin.versions[0].version;
                  if (plugin.compatibility.state === 'incompatible') void selectPlugin(plugin.name, version);
                  else void install(plugin.name, version).catch(() => {});
                }} />
            ))}
          </div>
          {catalog && totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2 pb-4">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="w-8 h-8 rounded-lg border border-[var(--dm-border)] text-[var(--text-secondary)] disabled:opacity-35 flex items-center justify-center">
                <FiChevronLeft size={14} />
              </button>
              <span className="dm-num text-[11px] text-[var(--text-muted)] font-mono">{page} / {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="w-8 h-8 rounded-lg border border-[var(--dm-border)] text-[var(--text-secondary)] disabled:opacity-35 flex items-center justify-center">
                <FiChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
      {repoOpen && <RepositoryImportDialog t={t} onClose={() => setRepoOpen(false)} />}
    </div>
  );
}

function PluginCard({ plugin, t, onOpen, onInstall }: {
  plugin: CatalogPage['items'][number];
  t: (key: string) => string;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const installed = plugin.installed;
  const latest = plugin.versions[0];
  const canUpdate = installed && semver.gt(latest.version, installed.version);
  const hasClient = Boolean(plugin.dsh?.client);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpen();
        }
      }}
      className="dm-card group rounded-xl border border-[var(--dm-border)] bg-[var(--dm-surface)]/55 p-3.5 text-left flex flex-col gap-2.5 min-w-0 cursor-pointer"
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <PluginIcon plugin={plugin} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13.5px] font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">{plugin.title}</span>
            {plugin.demo && <span className="text-[9.5px] px-1.5 py-0.5 rounded-md bg-[var(--accent-soft)] text-[var(--accent)]">{t('demo')}</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 flex-wrap text-[10.5px] text-[var(--text-muted)]">
            <span className="font-mono truncate max-w-[180px]">{plugin.name}</span>
            <span>·</span>
            <span className="dm-num font-mono">v{latest.version}</span>
            {plugin.author && <><span>·</span><span className="truncate">{plugin.author}</span></>}
          </div>
        </div>
      </div>
      <p className="dm-prose text-[12px] leading-[1.55] text-[var(--text-secondary)] line-clamp-2 min-h-[2.6em]">{plugin.description || t('noDescription')}</p>
      <div className="flex items-center gap-1.5 flex-wrap">
        <CompatBadge state={plugin.compatibility.state}>{t(plugin.compatibility.state)}</CompatBadge>
        <SourceBadge plugin={plugin} />
        {hasClient && (
          <span className="text-[9.5px] px-1.5 py-0.5 rounded-md bg-sky-500/12 text-sky-600 dark:text-sky-400 border border-sky-500/20">
            {t('clientBridgeCap')}
          </span>
        )}
        {plugin.stats?.npmDownloadsLastWeek !== undefined && (
          <span className="dm-num text-[9.5px] px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-muted)] inline-flex items-center gap-1 font-mono">
            <FiDownload size={9} />{formatNumber(plugin.stats.npmDownloadsLastWeek)}/wk
          </span>
        )}
      </div>
      <div className="mt-auto pt-2 border-t border-[var(--dm-border)]/60 flex items-center justify-between gap-2">
        <span className="dm-num text-[10.5px] text-[var(--text-muted)] truncate font-mono">
          {installed ? `${t('installedState')} · v${installed.version}` : latest.source.type === 'bundled-example' ? 'sample' : latest.source.type}
        </span>
        {installed ? (
          canUpdate ? (
            <button onClick={(event) => { event.stopPropagation(); onInstall(); }}
              className="px-2.5 py-1 rounded-lg bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)]">
              {t('update')}
            </button>
          ) : (
            <span className="text-[10.5px] text-emerald-600 dark:text-emerald-400 font-medium">{t('installedState')}</span>
          )
        ) : (
          <button onClick={(event) => { event.stopPropagation(); onInstall(); }}
            className="px-2.5 py-1 rounded-lg bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)]">
            {t('install')}
          </button>
        )}
      </div>
    </div>
  );
}
