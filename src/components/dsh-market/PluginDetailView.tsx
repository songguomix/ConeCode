import { useEffect, useState } from 'react';
import semver from 'semver';
import {
  FiAlertTriangle, FiArrowLeft, FiCheckCircle, FiChevronRight, FiCode,
  FiExternalLink, FiFileText, FiGitBranch, FiPackage, FiPlay, FiRefreshCw,
  FiRotateCcw, FiTrash2, FiX,
} from 'react-icons/fi';
import { useDshMarketStore } from '../../stores/dshMarket.store';
import {
  CompatBadge, MarketMarkdown, PluginIcon, SourceBadge, StatusBadge,
  formatDate, formatDateTime, formatNumber,
} from './MarketCommon';

export default function PluginDetailView({ t }: { t: (key: string) => string }) {
  const detail = useDshMarketStore((s) => s.detail);
  const loading = useDshMarketStore((s) => s.detailLoading);
  const error = useDshMarketStore((s) => s.error);
  const clearError = useDshMarketStore((s) => s.clearError);
  const clearSelection = useDshMarketStore((s) => s.clearSelection);
  const selectPlugin = useDshMarketStore((s) => s.selectPlugin);
  const install = useDshMarketStore((s) => s.install);
  const update = useDshMarketStore((s) => s.update);
  const rollback = useDshMarketStore((s) => s.rollback);
  const uninstall = useDshMarketStore((s) => s.uninstall);
  const setEnabled = useDshMarketStore((s) => s.setEnabled);
  const openExternal = useDshMarketStore((s) => s.openExternal);
  const revealPath = useDshMarketStore((s) => s.revealPath);

  const [risk, setRisk] = useState<{ version: string; mode: 'install' | 'update' } | null>(null);
  const [allowScripts, setAllowScripts] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [deleteData, setDeleteData] = useState(false);

  useEffect(() => {
    setRisk(null);
    setConfirmUninstall(false);
    setDeleteData(false);
  }, [detail?.plugin.name, detail?.version.version]);

  if (loading && !detail) {
    return <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">{t('loading')}</div>;
  }
  if (!detail) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
        <span>{error || t('empty')}</span>
        <button onClick={clearSelection} className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-[11px]">{t('back')}</button>
      </div>
    );
  }

  const { plugin, version, versions, installed } = detail;
  const selectedCompatibility = detail.versions.find((item) => item.version === version.version)?.compatibility;
  const installedHere = installed?.version === version.version;
  const newer = installed ? versions.find((item) => semver.gt(item.version, installed.version)) : null;
  const canRiskInstall = selectedCompatibility?.state === 'incompatible';
  const riskReasons = risk ? versions.find((item) => item.version === risk.version)?.compatibility.reasons : undefined;

  const doInstall = (targetVersion: string, mode: 'install' | 'update') => {
    if (targetVersion === installed?.version) return;
    const compatibility = versions.find((item) => item.version === targetVersion)?.compatibility;
    if (compatibility?.state === 'incompatible') {
      clearError();
      setRisk({ version: targetVersion, mode });
      return;
    }
    void install(plugin.name, targetVersion, false, allowScripts).catch((installError) => {
      const message = installError instanceof Error ? installError.message : String(installError);
      if (message.includes('Incompatible plugin')) setRisk({ version: targetVersion, mode });
    });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 border-b border-[var(--border)] px-5 py-3 flex items-start gap-3">
        <button onClick={clearSelection} className="w-8 h-8 rounded-xl border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center shrink-0" title={t('back')}>
          <FiArrowLeft size={14} />
        </button>
        <PluginIcon plugin={plugin} size="w-12 h-12" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">{plugin.title}</h2>
            {plugin.demo && <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)]">{t('demo')}</span>}
            <CompatBadge state={selectedCompatibility?.state || 'unverified'}>{t(selectedCompatibility?.state || 'unverified')}</CompatBadge>
            <SourceBadge plugin={plugin} />
            {installed && <span className="text-[10.5px] inline-flex items-center gap-1 text-[var(--text-muted)]"><FiPackage size={10} />{t('installedState')} · v{installed.version}</span>}
          </div>
          <div className="mt-1 flex items-center gap-2 flex-wrap text-[10.5px] text-[var(--text-muted)]">
            <span className="font-mono">{plugin.name}@{version.version}</span>
            {plugin.author && <><span>·</span><span>{t('author')}: {plugin.author}</span></>}
            {plugin.license && <><span>·</span><span>{plugin.license}</span></>}
            {plugin.repository && (
              <button onClick={() => void openExternal(plugin.repository!.url)} className="inline-flex items-center gap-1 hover:text-[var(--accent)]">
                <FiGitBranch size={10} />{t('openExternal')}
              </button>
            )}
            {plugin.homepage && (
              <button onClick={() => void openExternal(plugin.homepage!)} className="inline-flex items-center gap-1 hover:text-[var(--accent)]">
                <FiExternalLink size={10} />Homepage
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {installedHere ? (
            <div className="flex items-center gap-1.5">
              <button onClick={() => void setEnabled(installed.id, !installed.enabled).catch(() => {})}
                className={`px-2.5 py-1.5 rounded-lg text-[10.5px] font-medium ${installed.enabled ? 'border border-[var(--border)] text-[var(--text-secondary)]' : 'bg-[var(--accent)] text-white'}`}>
                {installed.enabled ? t('disable') : t('enable')}
              </button>
              <button onClick={() => setConfirmUninstall(true)} className="px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[10.5px] text-[var(--text-muted)] hover:text-[var(--error)]">{t('uninstall')}</button>
            </div>
          ) : installed ? (
            <div className="flex items-center gap-1.5">
              <button onClick={() => doInstall(version.version, 'update')}
                className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[10.5px] font-medium">
                {t('updateTo')} v{version.version}
              </button>
              <button onClick={() => void rollback(installed.id).catch(() => {})} className="px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[10.5px] text-[var(--text-secondary)]">
                <FiRotateCcw size={10} className="inline mr-1" />{t('rollback')}
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-end gap-1">
              <button onClick={() => doInstall(version.version, 'install')}
                className="px-3.5 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)]">
                {t('install')} v{version.version}
              </button>
              {canRiskInstall && <span className="text-[9.5px] text-[var(--warning)]">{t('incompatibleHint')}</span>}
            </div>
          )}
          <label className="flex items-center gap-1 text-[9.5px] text-[var(--text-muted)] cursor-pointer" title={t('scriptsHint')}>
            <input type="checkbox" checked={allowScripts} onChange={(event) => setAllowScripts(event.target.checked)} className="accent-[var(--accent)]" />
            {t('allowScripts')}
          </label>
        </div>
      </div>

      {error && <div className="mx-5 mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-400 whitespace-pre-wrap">{error}</div>}
      {newer && !installedHere && <div className="mx-5 mt-3 rounded-xl border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-[10.5px] text-[var(--text-muted)]">{t('updateAvailable')}: v{version.version}</div>}

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5">
        <div className="min-w-0 space-y-4">
          {detail.readme ? (
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/45 p-4">
              <div className="flex items-center gap-2 mb-2">
                <FiFileText size={13} className="text-[var(--accent)]" />
                <h3 className="text-[12px] font-semibold text-[var(--text-primary)]">{t('readme')}</h3>
                {detail.readmeSource && <span className="text-[9.5px] text-[var(--text-muted)] break-all">{detail.readmeSource}</span>}
              </div>
              <MarketMarkdown text={detail.readme} onLink={(href) => void openExternal(href)} onImage={(src) => setImage(src)} />
            </section>
          ) : (
            <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-[11px] text-[var(--text-secondary)]">
              <FiAlertTriangle size={12} className="inline mr-1.5" />{detail.readmeError || t('offline')}
            </section>
          )}

          {detail.screenshots.length > 0 && (
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/45 p-4">
              <h3 className="text-[12px] font-semibold text-[var(--text-primary)] mb-2">{t('screenshots')}</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {detail.screenshots.map((src) => (
                  <button key={src} onClick={() => setImage(src)} className="rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--bg-0)]">
                    <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" className="w-full h-28 object-cover" />
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/45 p-4">
            <div className="flex items-center gap-2 mb-2">
              <FiCode size={13} className="text-[var(--accent)]" />
              <h3 className="text-[12px] font-semibold text-[var(--text-primary)]">{t('versions')}</h3>
              <span className="text-[9.5px] text-[var(--text-muted)]">{versions.length}</span>
            </div>
            <div className="divide-y divide-[var(--border)]">
              {versions.map((item) => (
                <div key={item.version} className="py-2 flex items-center gap-2 flex-wrap">
                  <button onClick={() => void selectPlugin(plugin.name, item.version).catch(() => {})}
                    className={`text-[11px] font-mono ${item.version === version.version ? 'text-[var(--accent)] font-semibold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
                    v{item.version}
                  </button>
                  {item.version === plugin.versions[0].version && <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--bg-3)] text-[var(--text-muted)]">{t('latest')}</span>}
                  <CompatBadge state={item.compatibility.state}>{t(item.compatibility.state)}</CompatBadge>
                  <span className="text-[9.5px] text-[var(--text-muted)]">{formatDate(item.publishedAt)}</span>
                  {item.deprecated && <span className="text-[9.5px] text-[var(--warning)]">{item.deprecated}</span>}
                  <div className="ml-auto flex items-center gap-1">
                    {installed?.version === item.version ? (
                      <span className="text-[9.5px] text-emerald-600 dark:text-emerald-400">{t('installedState')}</span>
                    ) : (
                      <button onClick={() => doInstall(item.version, installed ? 'update' : 'install')}
                        className="px-2 py-0.5 rounded-md border border-[var(--border)] text-[9.5px] text-[var(--text-secondary)] hover:text-[var(--accent)]">
                        {installed ? t('updateTo') : t('install')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="min-w-0 space-y-3">
          <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/55 p-3.5">
            <h3 className="text-[11px] font-semibold text-[var(--text-primary)] mb-2">{t('compatibilityMatrix')}</h3>
            <div className="space-y-2 text-[10px]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">{t('declaredRange')}</span>
                <span className="font-mono text-right text-[var(--text-secondary)] break-all">{selectedCompatibility?.authoredRange || '—'}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">{t('actualResult')}</span>
                <CompatBadge state={selectedCompatibility?.state || 'unverified'}>{t(selectedCompatibility?.state || 'unverified')}</CompatBadge>
              </div>
            </div>
            <p className="mt-2 text-[9.5px] leading-relaxed text-[var(--text-muted)]">
              {selectedCompatibility?.state === 'verified' ? t('verifiedHint')
                : selectedCompatibility?.state === 'partial' ? t('partialHint')
                  : selectedCompatibility?.state === 'incompatible' ? t('incompatibleHint')
                    : t('unverifiedHint')}
            </p>
            {!!selectedCompatibility?.reasons.length && (
              <ul className="mt-2 space-y-1 text-[9.5px] text-[var(--text-muted)] list-disc pl-4">
                {selectedCompatibility.reasons.slice(0, 5).map((reason, index) => <li key={index}>{reason.message}</li>)}
              </ul>
            )}
            {!!selectedCompatibility?.missing.length && (
              <div className="mt-2">
                <div className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] mb-1">{t('missing')}</div>
                <div className="flex flex-wrap gap-1">
                  {selectedCompatibility.missing.map((item) => <span key={item} className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/12 text-amber-600 dark:text-amber-400 font-mono">{item}</span>)}
                </div>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/55 p-3.5 text-[10px]">
            <Info label={t('source')} value={version.source.type} mono />
            <Info label={t('version')} value={version.version} mono />
            <Info label={t('license')} value={plugin.license || '—'} />
            <Info label={t('category')} value={plugin.category} />
            <Info label={t('integrity')} value={version.integrity?.slice(0, 28) || (installed?.integrity?.slice(0, 28) || '—')} mono />
            {plugin.stats && (
              <div className="mt-2 pt-2 border-t border-[var(--border)] space-y-1">
                {plugin.stats.npmDownloadsLastWeek !== undefined && <Info label={t('downloads')} value={formatNumber(plugin.stats.npmDownloadsLastWeek)} />}
                {plugin.stats.githubStars !== undefined && <Info label={t('stars')} value={formatNumber(plugin.stats.githubStars)} />}
                <div className="text-[9px] text-[var(--text-muted)]">{t('statsProvenance')} {formatDate(plugin.stats.provenance.retrievedAt)} · {plugin.stats.provenance.source}</div>
              </div>
            )}
          </section>

          {installedHere && installed && (
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/55 p-3.5 text-[10px]">
              <div className="flex items-center gap-2 mb-2">
                <StatusBadge plugin={installed} text={t} />
                <span className="font-mono text-[9.5px] text-[var(--text-muted)]">{installed.format}</span>
              </div>
              <Info label="Requested" value={installed.requestedSpec} mono />
              <Info label="Resolved" value={installed.resolvedSpec} mono />
              <Info label={t('installPath')} value={installed.packageDir} mono />
              <button onClick={() => void revealPath(installed.packageDir)} className="mt-1 text-[9.5px] text-[var(--accent)] hover:underline">{t('revealPath')}</button>
              <Info label={t('installedAt')} value={formatDateTime(installed.installedAt)} />
              {installed.lastError && <div className="mt-1.5 text-[var(--error)] whitespace-pre-wrap">{t('lastError')}: {installed.lastError}</div>}
              {installed.backups.length > 0 && (
                <div className="mt-2">
                  <div className="text-[9px] uppercase tracking-wider text-[var(--text-muted)] mb-1">{t('backups')}</div>
                  {installed.backups.map((backup) => (
                    <button key={backup.directory} onClick={() => void rollback(installed.id, backup.version).catch(() => {})}
                      className="w-full text-left px-2 py-1 rounded-lg border border-[var(--border)] text-[9.5px] text-[var(--text-secondary)] hover:text-[var(--accent)] mb-1">
                      v{backup.version} · {formatDateTime(backup.createdAt)}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {installedHere && installed && !!installed.requiredServices?.length && (
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/55 p-3.5 text-[10px]">
              <h3 className="text-[11px] font-semibold text-[var(--text-primary)] mb-2">{t('hostCapabilities')}</h3>
              <div className="flex flex-wrap gap-1">
                {installed.requiredServices.map((service) => {
                  const provided = ['tools', 'commands', 'skills', 'credentials', 'logger', 'events', 'reflect', 'registry', 'fiber'].includes(service);
                  return (
                    <span key={service} className={`text-[9px] px-1.5 py-0.5 rounded font-mono border ${provided ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' : 'bg-amber-500/12 text-amber-600 dark:text-amber-400 border-amber-500/20'}`}>
                      {service} · {provided ? 'provided' : 'missing'}
                    </span>
                  );
                })}
              </div>
            </section>
          )}

          {installedHere && installed && (
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/55 p-3.5 text-[10px]">
              <h3 className="text-[11px] font-semibold text-[var(--text-primary)] mb-2">{t('configTitle')}</h3>
              {installed.rows.length === 0 && <p className="text-[var(--text-muted)]">{t('noConfig')}</p>}
              {installed.rows.map((row) => (
                <div key={row.id} className="mb-2">
                  <div className="text-[9px] font-mono text-[var(--text-muted)] mb-1">{row.id} · {row.name}</div>
                  <pre className="max-h-24 overflow-auto rounded-lg bg-[var(--bg-0)] border border-[var(--border)] p-2 text-[9px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap">{JSON.stringify(row.config ?? {}, null, 2)}</pre>
                </div>
              ))}
              <p className="text-[9px] text-[var(--text-muted)]">{t('configHint')}</p>
            </section>
          )}

          {plugin.format === 'dsh' && (
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/55 p-3.5 text-[10px]">
              <h3 className="text-[11px] font-semibold text-[var(--text-primary)] mb-2">{t('dependencies')}</h3>
              {Object.keys(version.dependencies).length === 0 && Object.keys(version.peerDependencies).length === 0 && <p className="text-[var(--text-muted)]">—</p>}
              {Object.entries(version.dependencies).map(([name, range]) => <Info key={name} label={name} value={range} mono />)}
              {Object.entries(version.peerDependencies).map(([name, range]) => <Info key={name} label={`${name} (peer)`} value={range} mono />)}
            </section>
          )}

          {detail.verification && (
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/55 p-3.5">
              <h3 className="text-[11px] font-semibold text-[var(--text-primary)] mb-2">{t('evidence')}</h3>
              <div className="space-y-1.5">
                {detail.verification.verifiedCapabilities.map((capability) => (
                  <div key={capability} className="flex items-center gap-1.5 text-[9.5px] text-[var(--text-secondary)]"><FiCheckCircle size={9} className="text-emerald-500 shrink-0" />{capability}</div>
                ))}
                {detail.verification.evidence.slice(0, 6).map((item, index) => (
                  <div key={index} className="text-[9.5px] text-[var(--text-muted)]">
                    <span className="font-mono text-[8.5px] uppercase text-[var(--accent)]">{item.kind}</span> · {item.summary}
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[9px] text-[var(--text-muted)]">
                {detail.verification.recordedAt && `${t('verifiedAt')} ${formatDateTime(detail.verification.recordedAt)} · `}
                {detail.verification.environment.nodeVersion} · {detail.verification.environment.platform}/{detail.verification.environment.arch}
              </div>
            </section>
          )}

          <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/45 p-3.5 text-[9.5px] text-[var(--text-muted)] leading-relaxed space-y-1">
            {detail.runtimeNotes.map((note, index) => <p key={index}>{note}</p>)}
          </section>
        </aside>
      </div>

      {risk && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--bg-0)] p-4 shadow-2xl">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--warning)]"><FiAlertTriangle size={14} />{t('riskTitle')}</div>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">{t('riskBody')}</p>
            {!!riskReasons?.length && (
              <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-[var(--text-secondary)]">
                {riskReasons.map((reason, index) => <li key={index}>{reason.message}</li>)}
              </ul>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setRisk(null)} className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-[11px] text-[var(--text-secondary)]">{t('cancel')}</button>
              <button
                onClick={() => {
                  const target = risk;
                  setRisk(null);
                  void install(plugin.name, target.version, true, allowScripts).catch(() => {});
                }}
                className="px-3 py-1.5 rounded-lg bg-amber-500 text-white text-[11px] font-medium"
              >
                {t('acceptRisk')}
              </button>
            </div>
          </div>
        </div>
      )}

      {image && (
        <div className="fixed inset-0 z-[96] flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm" onClick={() => setImage(null)}>
          <img src={image} alt="" referrerPolicy="no-referrer" className="max-w-full max-h-full rounded-xl shadow-2xl" />
          <button onClick={() => setImage(null)} className="absolute top-4 right-4 w-9 h-9 rounded-full bg-black/50 text-white flex items-center justify-center"><FiX size={16} /></button>
        </div>
      )}

      {confirmUninstall && installed && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--bg-0)] p-4 shadow-2xl">
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">{t('confirmUninstall')}</div>
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">{t('dataPolicy')}</p>
            <label className="mt-3 flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
              <input type="checkbox" checked={deleteData} onChange={(event) => setDeleteData(event.target.checked)} className="accent-red-500" />
              {t('deleteData')}
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmUninstall(false)} className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-[11px] text-[var(--text-secondary)]">{t('cancel')}</button>
              <button onClick={() => { setConfirmUninstall(false); void uninstall(installed.id, deleteData).catch(() => {}); }}
                className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-[11px] font-medium">{t('confirm')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-2 py-0.5 min-w-0">
      <span className="text-[var(--text-muted)] shrink-0 max-w-[45%] truncate" title={label}>{label}</span>
      <span className={`text-right break-all ${mono ? 'font-mono' : ''} text-[var(--text-secondary)]`}>{value}</span>
    </div>
  );
}
