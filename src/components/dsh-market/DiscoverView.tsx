import { FiChevronDown, FiChevronLeft, FiChevronRight, FiDownload, FiGitBranch, FiRefreshCw, FiSearch, FiX } from 'react-icons/fi';
import { useState } from 'react';
import semver from 'semver';
import { useDshMarketStore } from '../../stores/dshMarket.store';
import { useLanguageStore } from '../../stores';
import type { MarketPlugin } from '../../core/dsh-market/types';
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
  const localPreview = useDshMarketStore((s) => s.localPreview);
  const setQuery = useDshMarketStore((s) => s.setQuery);
  const setCategory = useDshMarketStore((s) => s.setCategory);
  const setLabel = useDshMarketStore((s) => s.setLabel);
  const setSort = useDshMarketStore((s) => s.setSort);
  const setPage = useDshMarketStore((s) => s.setPage);
  const setCompatibleOnly = useDshMarketStore((s) => s.setCompatibleOnly);
  const refresh = useDshMarketStore((s) => s.refresh);
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
  const showLocal = query.trim() === '' && (category === 'all' || category === 'native');

  if (!snapshot && loading) {
    return <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">{t('loading')}</div>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="sticky top-0 z-10 bg-[var(--bg-0)]/95 backdrop-blur-xl border-b border-[var(--border)] px-5 pt-4 pb-3 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <FiSearch size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('searchPh')}
              spellCheck={false}
              autoFocus
              className="w-full pl-9 pr-9 py-2 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_18%,transparent)]"
            />
            {query && (
              <button onClick={() => setQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)]" title={t('all')}>
                <FiX size={12} />
              </button>
            )}
          </div>
          <div className="relative shrink-0">
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as any)}
              aria-label={t('sort')}
              className="h-9 pl-2.5 pr-8 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-xs text-[var(--text-secondary)] outline-none focus:border-[var(--accent)] appearance-none cursor-pointer"
            >
              <option value="relevance">{t('sortRelevance')}</option>
              <option value="name">{t('sortName')}</option>
              <option value="updated">{t('sortUpdated')}</option>
              <option value="downloads">{t('sortDownloads')}</option>
              <option value="stars">{t('sortStars')}</option>
            </select>
            <FiChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-muted)]" />
          </div>
          <label className="inline-flex items-center gap-1.5 h-9 px-2.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-[11px] text-[var(--text-secondary)] cursor-pointer select-none">
            <input type="checkbox" checked={compatibleOnly} onChange={(event) => setCompatibleOnly(event.target.checked)} className="accent-[var(--accent)]" />
            {t('compatibleOnly')}
          </label>
          <button onClick={() => setRepoOpen(true)} title={t('importRepo')}
            className="h-9 px-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-1)] text-[var(--text-secondary)] hover:text-[var(--accent)] inline-flex items-center gap-1.5 text-[11px]">
            <FiGitBranch size={12} />{t('importRepo')}
          </button>
          <button onClick={() => void refresh().catch(() => {})} title={t('sync')} className="w-9 h-9 rounded-xl border border-[var(--border)] bg-[var(--bg-1)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center">
            <FiRefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          <button onClick={() => setCategory('all')}
            className={`shrink-0 px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${category === 'all' ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)] font-medium' : 'bg-[var(--bg-1)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-primary)]'}`}>
            {t('all')} <span className="opacity-60">{catalog?.total ?? 0}</span>
          </button>
          {categories.map((item) => (
            <button key={item.id} onClick={() => setCategory(item.id)}
              className={`shrink-0 px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${category === item.id ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)] font-medium' : 'bg-[var(--bg-1)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-primary)]'}`}>
              {locale === 'zh' || locale === 'zhHant' ? item.title.zh : item.title.en}
              <span className="ml-1 opacity-60">{item.count}</span>
            </button>
          ))}
          <span className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)] px-1">
            {catalog?.total ?? 0} {t('results')}
          </span>
        </div>
        {labels.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">{t('tags')}</span>
            {labels.map((item) => (
              <button key={item.id} onClick={() => setLabel(item.id)}
                className={`shrink-0 px-2 py-0.5 rounded-md text-[10px] border transition-colors ${label === item.id ? 'bg-[var(--accent)] text-white border-[var(--accent)]' : 'bg-transparent text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-primary)]'}`}>
                #{item.id}
                <span className="ml-1 opacity-60">{item.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="px-5 py-4 space-y-3">
        {localPreview && showLocal && (
          <div className="rounded-2xl border border-[var(--accent-border)] bg-[var(--accent-soft)]/40 p-3.5">
            <div className="flex items-start gap-3">
              <PluginIcon plugin={localPreview.plugin} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">{localPreview.plugin.title}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-muted)] font-mono">local · {localPreview.plugin.name}@{localPreview.version.version}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-muted)]">{t('localImport')}</span>
                </div>
                <p className="mt-1 text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap">{localPreview.plugin.description || t('noDescription')}</p>
                <p className="mt-1 text-[10px] text-[var(--text-muted)]">{t('localImportHint')}</p>
                {localPreview.warnings.length > 0 && (
                  <div className="mt-1.5 text-[10px] text-[var(--warning)] whitespace-pre-wrap">
                    <span className="font-medium">{t('localWarnings')}: </span>{localPreview.warnings.join(' · ')}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <button onClick={() => void installLocal(false).catch(() => {})} className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)]">
                  {t('localInstall')}
                </button>
                <button onClick={clearLocalPreview} className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                  {t('cancel')}
                </button>
              </div>
            </div>
          </div>
        )}

        {loading && !catalog && <p className="text-xs text-[var(--text-muted)]">{t('loading')}</p>}
        {catalog && catalog.items.length === 0 && (
          <div className="py-16 text-center">
            <div className="text-3xl mb-2">🧩</div>
            <p className="text-sm text-[var(--text-muted)]">{t('empty')}</p>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {catalog?.items.map((plugin) => (
            <PluginCard key={plugin.name} plugin={plugin} t={t}
              onOpen={() => void selectPlugin(plugin.name).catch(() => {})}
              onInstall={() => void install(plugin.name, plugin.versions[0].version).catch(() => {})}
              onUpdate={() => {
                const installed = plugin.installed;
                if (installed) {
                  const newer = plugin.versions.find((version) => semver.gt(version.version, installed.version));
                  if (newer) void install(plugin.name, newer.version).catch(() => {});
                }
              }} />
          ))}
        </div>
        {catalog && totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-2 pb-4">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="w-8 h-8 rounded-lg border border-[var(--border)] text-[var(--text-secondary)] disabled:opacity-35 flex items-center justify-center">
              <FiChevronLeft size={14} />
            </button>
            <span className="text-[11px] text-[var(--text-muted)] font-mono">{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="w-8 h-8 rounded-lg border border-[var(--border)] text-[var(--text-secondary)] disabled:opacity-35 flex items-center justify-center">
              <FiChevronRight size={14} />
            </button>
          </div>
        )}
      </div>
      {repoOpen && <RepositoryImportDialog t={t} onClose={() => setRepoOpen(false)} onInstalled={() => setRepoOpen(false)} />}
    </div>
  );
}

function PluginCard({ plugin, t, onOpen, onInstall, onUpdate }: {
  plugin: MarketPlugin & { compatibility: any; installed: any };
  t: (key: string) => string;
  onOpen: () => void;
  onInstall: () => void;
  onUpdate: () => void;
}) {
  const installed = plugin.installed;
  const latest = plugin.versions[0];
  const canUpdate = installed && semver.gt(latest.version, installed.version);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/70 p-3 text-left flex flex-col gap-2.5 min-w-0 hover:border-[color-mix(in_srgb,var(--accent)_45%,transparent)] hover:bg-[var(--bg-2)] transition-colors cursor-pointer"
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <PluginIcon plugin={plugin} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)]">{plugin.title}</span>
            {plugin.demo && <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)]">{t('demo')}</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 flex-wrap text-[10px] text-[var(--text-muted)]">
            <span className="font-mono truncate max-w-[150px]">{plugin.name}</span>
            <span>·</span>
            <span>v{latest.version}</span>
            {plugin.author && <><span>·</span><span className="truncate">{plugin.author}</span></>}
          </div>
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-[var(--text-secondary)] line-clamp-3 min-h-[3.2em]">{plugin.description || t('noDescription')}</p>
      <div className="flex items-center gap-1.5 flex-wrap">
        <CompatBadge state={plugin.compatibility.state}>{t(plugin.compatibility.state)}</CompatBadge>
        <SourceBadge plugin={plugin} />
        {plugin.stats?.npmDownloadsLastWeek !== undefined && (
          <span className="text-[9.5px] px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-muted)] inline-flex items-center gap-1">
            <FiDownload size={9} />{formatNumber(plugin.stats.npmDownloadsLastWeek)}/wk
          </span>
        )}
        <span className="text-[9.5px] px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-muted)]">{plugin.category}</span>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="text-[10px] text-[var(--text-muted)] truncate">
          {installed ? `${t('installedState')} · v${installed.version}` : latest.source.type === 'bundled-example' ? 'sample' : latest.source.type}
        </span>
        {installed ? (
          canUpdate ? (
            <button onClick={(event) => { event.stopPropagation(); onUpdate(); }}
              className="px-2.5 py-1 rounded-lg bg-[var(--accent)] text-white text-[10.5px] font-medium hover:bg-[var(--accent-hover)]">
              {t('update')}
            </button>
          ) : (
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">{t('installedState')}</span>
          )
        ) : (
          <button onClick={(event) => { event.stopPropagation(); onInstall(); }}
            className="px-2.5 py-1 rounded-lg bg-[var(--accent)] text-white text-[10.5px] font-medium hover:bg-[var(--accent-hover)]">
            {t('install')}
          </button>
        )}
      </div>
    </div>
  );
}
