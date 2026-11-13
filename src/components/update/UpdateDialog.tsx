import { useEffect, useId, useRef } from 'react';
import { FiX, FiDownload, FiCheckCircle, FiFolder, FiArrowRight } from 'react-icons/fi';
import { useLanguageStore, useUpdateStore } from '../../stores';
import {
  downloadPercent,
  formatReleaseDate,
  updateDownloadErrorMessage,
} from './updateMessages';

/**
 * "New version available" dialog.
 *
 * Closing it is not a dismissal of the update itself: the offer moves into
 * Settings → Updates (and the same version will not pop up again).
 */
export default function UpdateDialog() {
  const t = useLanguageStore((s) => s.t);
  const dialogOpen = useUpdateStore((s) => s.dialogOpen);
  const result = useUpdateStore((s) => s.result);
  const download = useUpdateStore((s) => s.download);
  const downloadStarting = useUpdateStore((s) => s.downloadStarting);
  const downloadError = useUpdateStore((s) => s.downloadError);
  const dismissDialog = useUpdateStore((s) => s.dismissDialog);
  const startDownload = useUpdateStore((s) => s.startDownload);
  const reveal = useUpdateStore((s) => s.reveal);

  const titleId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);

  const latest = result?.latest ?? null;
  const open = dialogOpen && Boolean(latest);

  useEffect(() => {
    if (!open) return;
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      // Capture phase: keep Settings (also listening for Escape) from closing
      // underneath the update dialog.
      e.stopPropagation();
      dismissDialog();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, dismissDialog]);

  if (!open || !latest) return null;

  const downloading = download?.state === 'downloading' || downloadStarting;
  const completed = download?.state === 'completed';
  const received = download && 'received' in download ? download.received : 0;
  const total = download && 'total' in download && download.total > 0 ? download.total : latest.fileSize ?? 0;
  const percent = downloadPercent(received, total);
  const published = formatReleaseDate(latest.publishedAt);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) dismissDialog();
      }}
      className="fixed inset-0 bg-black/45 backdrop-blur-sm flex items-center justify-center z-[70] p-4 anim-scrim"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[560px] max-w-[calc(100vw-32px)] max-h-[calc(100dvh-48px)] flex flex-col bg-[var(--bg-0)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden anim-modal ring-1 ring-black/5 dark:ring-white/10"
      >
        <header className="px-5 pt-5 pb-4 flex items-start gap-3.5 shrink-0">
          <div className="w-10 h-10 rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] border border-[color-mix(in_srgb,var(--accent)_22%,transparent)] flex items-center justify-center shrink-0">
            <FiDownload size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-[16px] font-bold text-[var(--text-primary)] font-serif tracking-tight">
              {t('updateNewVersionTitle')}
            </h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)] break-words">
              ConeCode {latest.version}
              {latest.fileSizeLabel ? ` · ${latest.fileSizeLabel}` : ''}
              {published ? ` · ${t('updatePublished')} ${published}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={dismissDialog}
            aria-label={t('close')}
            className="p-1.5 -mr-1 -mt-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)] transition-colors cursor-pointer"
          >
            <FiX size={16} />
          </button>
        </header>

        <div className="px-5 pb-4 overflow-y-auto flex-1 min-h-0">
          <div className="flex items-center gap-2 text-xs mb-3">
            <span className="px-2 py-0.5 rounded-md bg-[var(--bg-2)] border border-[var(--border)] text-[var(--text-secondary)] font-medium">
              {t('updateCurrentVersion')} {result?.currentVersion || '—'}
            </span>
            <FiArrowRight size={12} className="text-[var(--text-muted)]" />
            <span className="px-2 py-0.5 rounded-md bg-[var(--accent-soft)] border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] text-[var(--accent)] font-semibold">
              {t('updateLatestVersion')} {latest.version}
            </span>
          </div>

          <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">{t('updateDialogBody')}</p>

          {latest.changelogItems.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1.5">
                {t('updateNotes')}
              </div>
              <ul className="space-y-1.5">
                {latest.changelogItems.map((item, index) => (
                  <li key={`${index}-${item}`} className="flex items-start gap-2 text-[13px] leading-snug text-[var(--text-secondary)]">
                    <span
                      aria-hidden="true"
                      className="mt-[6px] w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0 opacity-70"
                    />
                    <span className="break-words">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <footer className="px-5 py-4 border-t border-[color-mix(in_srgb,var(--border)_70%,transparent)] bg-[var(--bg-1)] shrink-0">
          {downloading && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] mb-1.5">
                <span>{downloadStarting ? t('updatePreparing') : t('updateDownloading')}</span>
                <span className="tabular-nums">{percent === null ? latest.fileSizeLabel ?? '' : `${percent}%`}</span>
              </div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
                className="h-1.5 rounded-full bg-[var(--bg-2)] overflow-hidden border border-[var(--border)]"
              >
                <div
                  className="h-full bg-[var(--accent)] transition-[width] duration-200"
                  style={{ width: `${percent ?? 8}%` }}
                />
              </div>
            </div>
          )}

          {completed && (
            <div className="mb-3 flex items-start gap-2 text-xs text-[var(--success)]">
              <FiCheckCircle size={14} className="mt-0.5 shrink-0" />
              <span className="leading-snug">{t('updateDownloaded')}</span>
            </div>
          )}

          {downloadError && (
            <p role="alert" className="mb-3 text-xs text-[var(--error)] break-words">
              {updateDownloadErrorMessage(t, downloadError)}
            </p>
          )}

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={dismissDialog}
              className="px-3.5 py-2 rounded-xl text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)] transition-colors cursor-pointer"
            >
              {t('updateLater')}
            </button>

            {completed ? (
              <button
                ref={primaryRef}
                type="button"
                onClick={() => void reveal()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
              >
                <FiFolder size={14} /> {t('updateReveal')}
              </button>
            ) : latest.downloadUrl ? (
              <button
                ref={primaryRef}
                type="button"
                onClick={() => void startDownload()}
                disabled={downloading}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <FiDownload size={14} /> {downloading ? t('updateDownloading') : t('updateDownload')}
              </button>
            ) : (
              <span className="text-[11px] text-[var(--text-muted)]">{t('updateNoInstaller')}</span>
            )}
          </div>

          <p className="mt-2.5 text-[11px] text-[var(--text-muted)]">
            {completed ? t('updateInstallHint') : `${t('updateInstallHint')} ${t('updateLaterHint')}`}
          </p>
        </footer>
      </div>
    </div>
  );
}
