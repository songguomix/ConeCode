import { useEffect, useRef, useState } from 'react';
import { FiGitBranch, FiSearch, FiShield, FiX } from 'react-icons/fi';
import { useChatStore, useLanguageStore, useModelStore, useUIStore, useWorkspaceStore } from '../../stores';

type ReviewScope = 'uncommitted' | 'base' | 'commit';

export default function CodeReviewPanel() {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const closeReview = useUIStore((state) => state.closeReview);
  const selectedModel = useModelStore((state) => state.getSelectedModel());
  const sendMessage = useChatStore((state) => state.sendMessage);
  const setReviewMode = useChatStore((state) => state.setReviewMode);
  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const { t } = useLanguageStore();
  const [scope, setScope] = useState<ReviewScope>('uncommitted');
  const [baseTarget, setBaseTarget] = useState('');
  const [commitTarget, setCommitTarget] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const busyRef = useRef(false);
  const target = scope === 'commit' ? commitTarget : baseTarget;

  useEffect(() => {
    request.current++;
    busyRef.current = false;
    setBusy(false);
    setError('');
    return () => { request.current++; };
  }, [rootPath, activeConversationId]);

  useEffect(() => {
    let cancelled = false;
    setBranches([]);
    setBaseTarget('');
    setCommitTarget('');
    if (!rootPath) return;
    window.electronAPI.git.branches(rootPath).then((items) => {
      if (cancelled || useWorkspaceStore.getState().rootPath !== rootPath) return;
      setBranches(items);
      const preferred = items.find((item) => item === 'main')
        || items.find((item) => item === 'master')
        || items.find((item) => item.endsWith('/main'))
        || items.find((item) => item.endsWith('/master'))
        || items[0];
      if (preferred) setBaseTarget(preferred);
    }).catch(() => {
      if (!cancelled && useWorkspaceStore.getState().rootPath === rootPath) setBranches([]);
    });
    return () => { cancelled = true; };
  }, [rootPath]);

  const startReview = async () => {
    if (!rootPath || !selectedModel || busyRef.current || (scope !== 'uncommitted' && !target.trim())) return;
    const id = ++request.current;
    const isCurrent = () => request.current === id
      && useWorkspaceStore.getState().rootPath === rootPath
      && useChatStore.getState().activeConversationId === activeConversationId;
    busyRef.current = true;
    setBusy(true);
    setError('');
    let dispatched = false;
    try {
      const result = await window.electronAPI.git.review(rootPath, {
        scope,
        target: scope === 'uncommitted' ? undefined : target.trim(),
      });
      if (!isCurrent()) return;
      if (!result.ok) throw new Error(result.error || t('reviewReadFailed'));
      if (!(result.diff || '').trim() && !(result.status || '').trim()) throw new Error(t('reviewNoChanges'));

      const maxDiff = 80_000;
      const diff = (result.diff || '').slice(0, maxDiff);
      const truncated = (result.diff || '').length > maxDiff;
      const prompt = `Review the following Git change set in read-only mode.

Scope: ${scope}${result.target ? ` (${result.target})` : ''}

Git status:
\`\`\`text
${result.status || '(clean status)'}
\`\`\`

Diff:
\`\`\`diff
${diff || '(No tracked diff. Inspect untracked paths from Git status with read-only tools.)'}
\`\`\`${truncated ? '\n\nThe diff was truncated. Use read-only Git/file tools to inspect the remaining changes.' : ''}

Return prioritized, actionable findings with exact file and line references. Do not modify the working tree.`;

      const previousReviewMode = useChatStore.getState().reviewMode;
      setReviewMode(true);
      dispatched = true;
      closeReview();
      try {
        await sendMessage(prompt, selectedModel.providerId, selectedModel.id);
      } finally {
        useChatStore.getState().setReviewMode(previousReviewMode);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('reviewReadFailed');
      if (dispatched) useChatStore.setState({ error: message });
      else if (isCurrent()) setError(message);
    } finally {
      if (request.current === id) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const scopes: { value: ReviewScope; label: string; hint: string }[] = [
    { value: 'uncommitted', label: t('reviewUncommitted'), hint: t('reviewUncommittedHint') },
    { value: 'base', label: t('reviewBase'), hint: t('reviewBaseHint') },
    { value: 'commit', label: t('reviewCommit'), hint: t('reviewCommitHint') },
  ];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-xs" onClick={closeReview} />
      <div className="fixed left-4 bottom-4 top-[96px] z-50 w-[380px] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-112px)] flex flex-col bg-[var(--glass-surface)] backdrop-blur-2xl border border-[var(--glass-border)] rounded-2xl shadow-2xl overflow-hidden anim-menu ring-1 ring-black/5 dark:ring-white/10">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--glass-border)] shrink-0">
          <FiShield size={16} className="text-[var(--accent)]" />
          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] font-serif font-bold text-[var(--text-primary)] tracking-tight">{t('codeReview')}</div>
            <div className="text-[11px] text-[var(--text-muted)]">{t('reviewReadOnly')}</div>
          </div>
          <button onClick={closeReview} aria-label={t('close')} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)] cursor-pointer transition-colors">
            <FiX size={15} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
          {!rootPath ? (
            <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)] text-center px-6">
              {t('reviewNeedsRepo')}
            </div>
          ) : (
            <>
              {scopes.map((item) => (
                <button key={item.value} onClick={() => setScope(item.value)} disabled={busy} aria-pressed={scope === item.value}
                  className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${
                    scope === item.value
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] bg-[var(--bg-2)] hover:bg-[var(--bg-3)]'
                  }`}>
                  <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                    {item.value === 'base' ? <FiGitBranch size={12} /> : <FiSearch size={12} />}
                    {item.label}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--text-muted)] leading-relaxed">{item.hint}</div>
                </button>
              ))}

              {scope === 'base' && (
                <select value={baseTarget} onChange={(event) => setBaseTarget(event.target.value)} disabled={busy || !branches.length} aria-label={t('reviewBase')}
                  className="w-full bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs outline-none focus:border-[var(--accent)]">
                  {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                </select>
              )}
              {scope === 'commit' && (
                <input value={commitTarget} onChange={(event) => setCommitTarget(event.target.value)} disabled={busy}
                  placeholder={t('reviewCommitPlaceholder')} aria-label={t('reviewCommitPlaceholder')}
                  className="w-full bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs font-mono outline-none focus:border-[var(--accent)]" />
              )}
              {error && <div role="alert" className="text-xs text-[var(--error)] whitespace-pre-wrap break-words">{error}</div>}
            </>
          )}
        </div>

        {rootPath && (
          <div className="p-3 border-t border-[var(--glass-border)] shrink-0">
            <button onClick={() => void startReview()} disabled={busy || !selectedModel || (scope !== 'uncommitted' && !target.trim())}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-[var(--accent)] text-white text-xs font-semibold hover:bg-[var(--accent-hover)] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed transition-all">
              <FiShield size={13} /> {busy ? t('reviewPreparing') : t('startReview')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
