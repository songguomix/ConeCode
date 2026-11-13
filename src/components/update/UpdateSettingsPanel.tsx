import { FiRefreshCw, FiDownload, FiFolder, FiCheckCircle, FiAlertCircle, FiArrowRight } from 'react-icons/fi';
import { useLanguageStore, useUpdateStore } from '../../stores';
import {
  downloadPercent,
  formatReleaseDate,
  updateDownloadErrorMessage,
  updateErrorMessage,
} from './updateMessages';

/**
 * Settings → Updates.
 *
 * This is where an available update lives after the user closes the popup, so
 * the offer is never lost and never nags twice for the same version.
 */
export default function UpdateSettingsPanel() {
  const t = useLanguageStore((s) => s.t);
  const currentVersion = useUpdateStore((s) => s.appVersion ?? s.result?.currentVersion ?? null);
  const result = useUpdateStore((s) => s.result);
  const checking = useUpdateStore((s) => s.checking);
  const errorCode = useUpdateStore((s) => s.errorCode);
  const lastCheckedAt = useUpdateStore((s) => s.lastCheckedAt);
  const download = useUpdateStore((s) => s.download);
  const downloadStarting = useUpdateStore((s) => s.downloadStarting);
  const downloadError = useUpdateStore((s) => s.downloadError);
  const check = useUpdateStore((s) => s.check);
  const startDownload = useUpdateStore((s) => s.startDownload);
  const reveal = useUpdateStore((s) => s.reveal);

  const latest = result?.latest ?? null;
  const hasUpdate = Boolean(result?.ok && result.updateAvailable && latest);
  const downloading = download?.state === 'downloading' || downloadStarting;
  const completed = download?.state === 'completed';
  const received = download && 'received' in download ? download.received : 0;
  const total = download && 'total' in download && download.total > 0 ? download.total : latest?.fileSize ?? 0;
  const percent = downloadPercent(received, total);
  const published = formatReleaseDate(latest?.publishedAt ?? null);

  return (
    <div className="space-y-3">
      <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl p-4 shadow-2xs space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <FiDownload size={14} className="text-[var(--accent)] shrink-0" />
            <span className="font-semibold text-sm text-[var(--text-primary)] truncate">ConeCode</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--bg-1)] text-[var(--text-secondary)] border border-[var(--border)] font-medium shrink-0">
              v{currentVersion || '—'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void check()}
            disabled={checking}
            className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#e88a6a] text-white text-xs font-medium hover:opacity-95 disabled:opacity-50 shadow-2xs cursor-pointer"
          >
            <FiRefreshCw size={12} className={checking ? 'animate-spin' : ''} />
            {checking ? t('updateChecking') : t('updateCheck')}
          </button>
        </div>

        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{t('setUpdatesDesc')}</p>

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {hasUpdate ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--accent-soft)] border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] text-[var(--accent)] font-semibold">
              {t('updateAvailableHint')} · v{latest?.version}
            </span>
          ) : result?.status === 'no_compatible_release' && !checking ? (
            <span className="text-[var(--text-secondary)]">{t('updateNoCompatibleRelease')}</span>
          ) : result?.ok && !checking ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success)] font-medium">
              <FiCheckCircle size={11} /> {t('updateUpToDate')}
            </span>
          ) : null}
          {lastCheckedAt && (
            <span className="text-[var(--text-muted)]">
              {new Date(lastCheckedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

        {errorCode && !checking && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] px-3 py-2 text-[11px] text-[var(--error)]"
          >
            <FiAlertCircle size={13} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-semibold">{t('updateErrorTitle')}</div>
              <div className="mt-0.5 break-words">{updateErrorMessage(t, errorCode)}</div>
            </div>
          </div>
        )}
      </div>

      {hasUpdate && latest && (
        <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl p-4 shadow-2xs space-y-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-0.5 rounded-md bg-[var(--bg-1)] border border-[var(--border)] text-[var(--text-secondary)] font-medium">
              {t('updateCurrentVersion')} {result?.currentVersion || currentVersion || '—'}
            </span>
            <FiArrowRight size={12} className="text-[var(--text-muted)]" />
            <span className="px-2 py-0.5 rounded-md bg-[var(--accent-soft)] border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] text-[var(--accent)] font-semibold">
              {t('updateLatestVersion')} {latest.version}
            </span>
            {latest.fileSizeLabel && (
              <span className="text-[var(--text-muted)]">{latest.fileSizeLabel}</span>
            )}
          </div>

          {published && (
            <p className="text-[11px] text-[var(--text-muted)]">
              {t('updatePublished')} {published}
            </p>
          )}

          {latest.changelogItems.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1.5">
                {t('updateNotes')}
              </div>
              <ul className="space-y-1.5">
                {latest.changelogItems.map((item, index) => (
                  <li
                    key={`${index}-${item}`}
                    className="flex items-start gap-2 text-xs leading-snug text-[var(--text-secondary)]"
                  >
                    <span aria-hidden="true" className="mt-[5px] w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0 opacity-70" />
                    <span className="break-words">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {downloading && (
            <div>
              <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] mb-1.5">
                <span>{downloadStarting ? t('updatePreparing') : t('updateDownloading')}</span>
                <span className="tabular-nums">{percent === null ? latest.fileSizeLabel ?? '' : `${percent}%`}</span>
              </div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
                className="h-1.5 rounded-full bg-[var(--bg-1)] overflow-hidden border border-[var(--border)]"
              >
                <div
                  className="h-full bg-[var(--accent)] transition-[width] duration-200"
                  style={{ width: `${percent ?? 8}%` }}
                />
              </div>
            </div>
          )}

          {completed && (
            <div className="flex items-start gap-2 text-xs text-[var(--success)]">
              <FiCheckCircle size={13} className="mt-0.5 shrink-0" />
              <span className="leading-snug">{t('updateDownloaded')}</span>
            </div>
          )}

          {downloadError && (
            <p role="alert" className="text-[11px] text-[var(--error)] break-words">
              {updateDownloadErrorMessage(t, downloadError)}
            </p>
          )}

          <div className="flex items-center gap-2">
            {completed ? (
              <button
                type="button"
                onClick={() => void reveal()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
              >
                <FiFolder size={12} /> {t('updateReveal')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void startDownload()}
                disabled={downloading}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-semibold shadow-2xs transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <FiDownload size={12} /> {downloading ? t('updateDownloading') : t('updateDownload')}
              </button>
            )}
            {latest.downloadUrl === null && (
              <span className="text-[11px] text-[var(--text-muted)]">{t('updateNoInstaller')}</span>
            )}
          </div>

          <p className="text-[11px] text-[var(--text-muted)]">{t('updateInstallHint')}</p>
        </div>
      )}
    </div>
  );
}
