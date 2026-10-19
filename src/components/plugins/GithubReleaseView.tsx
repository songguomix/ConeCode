import { useRef, useState } from 'react';
import { useLanguageStore } from '../../stores';
import { loadGithubToken, normalizeRepo, useMarketStore } from '../../stores/market.store';

export default function GithubReleaseView() {
  const { t } = useLanguageStore();
  const configuredRepo = useMarketStore((s) => s.repo);
  const [repo, setRepo] = useState('');
  const [tag, setTag] = useState('');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [target, setTarget] = useState('main');
  const [files, setFiles] = useState<string[]>([]);
  const [draft, setDraft] = useState(false);
  const [prerelease, setPrerelease] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; url?: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const inputClass = 'w-full rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-2.5 py-2 text-xs outline-none focus:border-[var(--accent)]';
  const destination = normalizeRepo(repo || configuredRepo);
  const choose = async () => {
    try {
      const picked = await window.electronAPI.dialog.openFile();
      setFiles((previous) => [...new Set([...previous, ...picked])]);
    } catch { setResult({ ok: false, message: t('releaseSelectFailed') }); }
  };
  const publish = async () => {
    if (busy || !destination) return;
    dialog.current?.close();
    setBusy(true); setResult(null);
    try {
      const token = loadGithubToken();
      if (!token) { setResult({ ok: false, message: t('releaseTokenRequired') }); return; }
      setResult(await window.electronAPI.git.publishRelease({ repo: destination, token, tag, name, body, target, files: [...files], draft, prerelease }));
    } catch { setResult({ ok: false, message: t('releaseFailed') }); }
    finally { setBusy(false); }
  };
  return (
    <section className="mt-4 border-t border-[var(--border)] pt-4">
      <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">GitHub Release</h3>
      <p className="mb-3 text-xs leading-relaxed text-[var(--text-secondary)]">{t('releaseHint')}</p>
      <fieldset disabled={busy} className="space-y-2 disabled:opacity-60">
        <label className="block text-xs">{t('pluginRepoLabel')}<input aria-label={t('pluginRepoLabel')} className={inputClass} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={configuredRepo || 'owner/repo'} /></label>
        <label className="block text-xs">{t('releaseTag')}<input className={inputClass} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="v2.4.8" /></label>
        <label className="block text-xs">{t('releaseName')}<input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={tag} /></label>
        <label className="block text-xs">{t('releaseTarget')}<input className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)} /></label>
        <label className="block text-xs">{t('releaseNotes')}<textarea className={inputClass} rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        <button type="button" onClick={() => void choose()} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs">{t('releaseAttachments')}</button>
        <ul className="max-h-40 overflow-y-auto space-y-1">
          {files.map((file) => <li key={file} className="flex items-center gap-2 text-xs"><span title={file} className="min-w-0 flex-1 truncate">{file.split(/[\\/]/).pop()}</span><button type="button" onClick={() => setFiles((previous) => previous.filter((f) => f !== file))} aria-label={`${t('dismiss')} ${file}`}>×</button></li>)}
        </ul>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />{t('releaseDraft')}</label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} />{t('releasePrerelease')}</label>
        <button type="button" disabled={!destination || !tag.trim() || !target.trim() || !files.length} onClick={() => dialog.current?.showModal()} className="w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-40">{t('releaseReview')}</button>
      </fieldset>
      {busy && <p role="status" className="mt-2 text-xs">{t('releaseUploading')}</p>}
      {result && <div role="status" className={`mt-2 break-words text-xs ${result.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}><p>{result.message}</p>{result.url && <a href={result.url} target="_blank" rel="noopener noreferrer" className="underline">{t('releaseOpen')}</a>}</div>}
      <dialog ref={dialog} aria-labelledby="release-confirm-title" className="m-auto w-[min(440px,calc(100vw-32px))] rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] p-5 text-[var(--text-primary)] backdrop:bg-black/50">
        <h3 id="release-confirm-title" className="text-base font-semibold">{t('releaseReview')}</h3>
        <p className="mt-3 break-all text-sm">{destination} · {tag} · {target}</p>
        <p className="mt-2 text-xs">{draft ? t('releaseDraft') : t('releasePublic')} · {files.length} {t('releaseAttachments')}</p>
        <ul className="mt-2 max-h-40 overflow-y-auto text-xs">{files.map((file) => <li key={file} className="break-all">{file}</li>)}</ul>
        <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => dialog.current?.close()} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm">{t('cancel')}</button><button type="button" onClick={() => void publish()} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm text-white">{t('releasePublish')}</button></div>
      </dialog>
    </section>
  );
}
