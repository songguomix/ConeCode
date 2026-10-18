import { useEffect, useRef, useState } from 'react';
import { useGithubPushStore } from '../../stores/githubPush.store';
import { normalizeRepo } from '../../stores/market.store';
import { useLanguageStore } from '../../stores';

export default function GithubPushDialog() {
  const pending = useGithubPushStore((s) => s.pending);
  const confirm = useGithubPushStore((s) => s.confirm);
  const cancel = useGithubPushStore((s) => s.cancel);
  const { t } = useLanguageStore();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [repo, setRepo] = useState('');
  useEffect(() => {
    if (pending) {
      setRepo(pending.repo);
      dialogRef.current?.showModal();
    } else dialogRef.current?.close();
  }, [pending]);
  return (
    <dialog ref={dialogRef} onCancel={cancel} aria-labelledby="github-push-title"
      className="m-auto w-[min(440px,calc(100vw-32px)) rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] p-5 text-[var(--text-primary)] shadow-xl backdrop:bg-black/50">
      <form onSubmit={(event) => { event.preventDefault(); confirm(repo); }}>
        <h2 id="github-push-title" className="text-base font-semibold">{t('githubPushDestination')}</h2>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">{t('githubPushSource')}</p>
        <p className="mt-1 break-all font-mono text-xs">{pending?.root}</p>
        <label className="mt-4 block text-sm" htmlFor="github-push-repo">{t('pluginRepoLabel')}</label>
        <input id="github-push-repo" autoFocus value={repo} onChange={(event) => setRepo(event.target.value)}
          placeholder="owner/repo" autoComplete="off" spellCheck={false}
          className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-0)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" />
        <p className="mt-2 text-xs text-[var(--text-secondary)]">{t('githubPushConfirmHint')}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={cancel} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm">{t('cancel')}</button>
          <button type="submit" disabled={!normalizeRepo(repo)} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-white disabled:opacity-40">{t('pluginPushProject')}</button>
        </div>
      </form>
    </dialog>
  );
}
