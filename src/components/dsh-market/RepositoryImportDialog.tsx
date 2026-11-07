import { useState } from 'react';
import {
  FiAlertTriangle, FiCheckCircle, FiDownload, FiGitBranch, FiSearch, FiX,
} from 'react-icons/fi';
import type { RepositoryInspection } from '../../core/dsh-market/types';
import { useDshMarketStore } from '../../stores/dshMarket.store';
import { CompatBadge, PluginIcon } from './MarketCommon';

export default function RepositoryImportDialog({ t, onClose, onInstalled }: {
  t: (key: string) => string;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const installRepository = useDshMarketStore((s) => s.installRepository);
  const [input, setInput] = useState('');
  const [ref, setRef] = useState('');
  const [subdir, setSubdir] = useState('');
  const [allowScripts, setAllowScripts] = useState(false);
  const [acceptRisk, setAcceptRisk] = useState(false);
  const [inspection, setInspection] = useState<RepositoryInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inspect = async () => {
    setError(null);
    setInspection(null);
    setAcceptRisk(false);
    setInspecting(true);
    try {
      const bridge = (window as any).electronAPI?.dshMarket;
      if (!bridge?.inspectRepository) throw new Error('Electron runtime is unavailable.');
      const result = await bridge.inspectRepository(input.trim(), ref.trim() || undefined, subdir.trim() || undefined);
      setInspection(result);
    } catch (inspectError) {
      setError(`${t('repoInspectFailed')}: ${inspectError instanceof Error ? inspectError.message : String(inspectError)}`);
    } finally {
      setInspecting(false);
    }
  };

  const install = async () => {
    if (!inspection) return;
    setError(null);
    setInstalling(true);
    try {
      await installRepository(input.trim(), ref.trim() || undefined, subdir.trim() || undefined, acceptRisk, allowScripts);
      onInstalled();
      onClose();
    } catch (installError) {
      setError(`${t('repoInstallFailed')}: ${installError instanceof Error ? installError.message : String(installError)}`);
    } finally {
      setInstalling(false);
    }
  };

  const incompatible = inspection?.compatibility.state === 'incompatible';
  const canInstall = !!inspection && (!incompatible || acceptRisk);

  return (
    <div className="fixed inset-0 z-[97] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div role="dialog" aria-modal="true" aria-label={t('importRepo')}
        className="w-full max-w-2xl max-h-[90vh] rounded-2xl border border-[var(--border)] bg-[var(--bg-0)] shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)] shrink-0">
          <FiGitBranch size={15} className="text-[var(--accent)]" />
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold text-[var(--text-primary)]">{t('importRepo')}</div>
            <div className="text-[10px] text-[var(--text-muted)] truncate">{t('repoHint')}</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center" aria-label={t('close')}>
            <FiX size={15} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto min-h-0 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">{t('repoUrl')}</label>
            <input
              value={input}
              onChange={(event) => { setInput(event.target.value); setInspection(null); }}
              placeholder={t('repoUrlPh')}
              spellCheck={false}
              autoFocus
              className="w-full h-9 px-3 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-[11px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">{t('repoRef')}</label>
              <input
                value={ref}
                onChange={(event) => { setRef(event.target.value); setInspection(null); }}
                placeholder={t('repoRefPh')}
                spellCheck={false}
                className="w-full h-9 px-3 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-[11px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">{t('repoSubdir')}</label>
              <input
                value={subdir}
                onChange={(event) => { setSubdir(event.target.value); setInspection(null); }}
                placeholder={t('repoSubdirPh')}
                spellCheck={false}
                className="w-full h-9 px-3 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-[11px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={() => void inspect()} disabled={!input.trim() || inspecting}
              className="h-9 px-3 rounded-xl bg-[var(--accent)] text-white text-[11px] font-medium inline-flex items-center gap-1.5 disabled:opacity-40">
              <FiSearch size={12} />{inspecting ? t('inspectingRepo') : t('inspectRepo')}
            </button>
            <label className="inline-flex items-center gap-1.5 text-[10px] text-[var(--text-secondary)] cursor-pointer">
              <input type="checkbox" checked={allowScripts} onChange={(event) => setAllowScripts(event.target.checked)} className="accent-[var(--accent)]" />
              {t('allowScripts')}
            </label>
            <span className="text-[9.5px] text-[var(--text-muted)]">{t('repoPublicOnly')}</span>
          </div>

          {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-400 whitespace-pre-wrap">{error}</div>}

          {inspection && (
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/60 p-3.5">
              <div className="flex items-start gap-2.5">
                <PluginIcon plugin={inspection.plugin} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-semibold text-[var(--text-primary)]">{inspection.plugin.title}</span>
                    <CompatBadge state={inspection.compatibility.state}>{t(inspection.compatibility.state)}</CompatBadge>
                    <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--bg-3)] text-[var(--text-muted)] font-mono">git</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-[var(--text-muted)] font-mono break-all">
                    {inspection.plugin.name}@{inspection.version.version} · {inspection.commit}
                  </div>
                  <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{inspection.plugin.description || t('noDescription')}</p>
                  <div className="mt-1 text-[9.5px] text-[var(--text-muted)]">
                    {t('repoCommit')}: <span className="font-mono">{inspection.commit}</span>
                    {inspection.plugin.author ? ` · ${inspection.plugin.author}` : ''}
                    {inspection.plugin.license ? ` · ${inspection.plugin.license}` : ''}
                  </div>
                  {inspection.warnings.length > 0 && (
                    <div className="mt-1.5 text-[10px] text-[var(--warning)]">
                      <FiAlertTriangle size={10} className="inline mr-1" />{inspection.warnings.join(' · ')}
                    </div>
                  )}
                  {inspection.compatibility.reasons.length > 0 && (
                    <ul className="mt-2 list-disc pl-4 space-y-0.5 text-[10px] text-[var(--text-muted)]">
                      {inspection.compatibility.reasons.slice(0, 5).map((reason, index) => <li key={index}>{reason.message}</li>)}
                    </ul>
                  )}
                </div>
              </div>
              {incompatible && (
                <label className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-[10.5px] text-[var(--text-secondary)]">
                  <input type="checkbox" checked={acceptRisk} onChange={(event) => setAcceptRisk(event.target.checked)} className="mt-0.5 accent-amber-500" />
                  <span>{t('riskBody')}</span>
                </label>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-[11px] text-[var(--text-secondary)]">{t('cancel')}</button>
                <button onClick={() => void install()} disabled={!canInstall || installing}
                  className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[11px] font-medium inline-flex items-center gap-1.5 disabled:opacity-40">
                  <FiDownload size={12} />{installing ? t('installing') : t('installRepo')}
                </button>
              </div>
            </div>
          )}

          {!inspection && !inspecting && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)]/40 p-3 text-[10px] text-[var(--text-muted)] flex items-center gap-2">
              <FiCheckCircle size={11} className="text-[var(--accent)]" />
              {t('repoPreview')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
