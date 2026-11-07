import { useEffect, useRef } from 'react';
import { useGithubReleaseStore } from '../../stores/githubRelease.store';
import { useLanguageStore } from '../../stores';
import './plugin-layout.css';

/**
 * Review card for an AI-initiated GitHub release: the model filled in the tag,
 * notes and installer attachments, the user confirms the actual publish.
 */
export default function GithubReleaseDialog() {
  const pending = useGithubReleaseStore((s) => s.pending);
  const busy = useGithubReleaseStore((s) => s.busy);
  const confirm = useGithubReleaseStore((s) => s.confirm);
  const cancel = useGithubReleaseStore((s) => s.cancel);
  const { t } = useLanguageStore();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (pending) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [pending]);

  return (
    <dialog
      ref={dialogRef}
      onCancel={cancel}
      aria-labelledby="github-release-title"
      className="plugin-dialog m-auto w-[min(460px,calc(100vw-32px))] rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-surface)] backdrop-blur-2xl p-5 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm ring-1 ring-black/5 dark:ring-white/10"
    >
      <h2 id="github-release-title" className="font-serif text-base font-bold tracking-tight">{t('releaseReview')}</h2>
      <p className="mt-2 break-all font-mono text-xs">{pending?.repo}</p>
      <p className="mt-2 text-xs">{pending?.name} · <span className="font-mono">{pending?.tag}</span> · <span className="font-mono">{pending?.target}</span></p>
      <p className="mt-2 text-xs">
        {pending?.draft ? t('releaseDraft') : t('releasePublic')}
        {pending?.prerelease ? ` · ${t('releasePrerelease')}` : ''}
        {' · '}{pending?.files.length ?? 0} {t('releaseAttachments')}
      </p>
      {pending?.notes ? (
        <pre className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed rounded-lg bg-[var(--bg-0)] p-2 text-xs text-[var(--text-secondary)]">{pending.notes}</pre>
      ) : null}
      <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs">
        {pending?.files.map((file) => <li key={file} className="break-all font-mono text-[var(--text-secondary)]">{file}</li>)}
      </ul>
      <p className="mt-3 text-xs text-[var(--text-secondary)]">{t('githubPushConfirmHint')}</p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={cancel} disabled={busy} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm cursor-pointer disabled:cursor-not-allowed hover:bg-[var(--bg-1)] transition-colors">{t('cancel')}</button>
        <button type="button" onClick={confirm} disabled={busy} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-white disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed transition-all">
          {busy ? t('releaseUploading') : t('releasePublish')}
        </button>
      </div>
    </dialog>
  );
}
