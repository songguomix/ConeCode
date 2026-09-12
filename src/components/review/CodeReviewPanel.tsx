import { useEffect, useState } from 'react';
import { FiGitBranch, FiSearch, FiShield, FiX } from 'react-icons/fi';
import { useChatStore, useLanguageStore, useModelStore, useUIStore, useWorkspaceStore } from '../../stores';

type ReviewScope = 'uncommitted' | 'base' | 'commit';

export default function CodeReviewPanel() {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const closeReview = useUIStore((state) => state.closeReview);
  const selectedModel = useModelStore((state) => state.getSelectedModel());
  const sendMessage = useChatStore((state) => state.sendMessage);
  const setReviewMode = useChatStore((state) => state.setReviewMode);
  const { t } = useLanguageStore();
  const [scope, setScope] = useState<ReviewScope>('uncommitted');
  const [target, setTarget] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!rootPath) return;
    window.electronAPI.git.branches(rootPath).then((items) => {
      setBranches(items);
      const preferred = items.find((item) => item === 'main')
        || items.find((item) => item === 'master')
        || items.find((item) => item.endsWith('/main'))
        || items.find((item) => item.endsWith('/master'))
        || items[0];
      if (preferred) setTarget(preferred);
    }).catch(() => setBranches([]));
  }, [rootPath]);

  const startReview = async () => {
    if (!rootPath || !selectedModel) return;
    setBusy(true);
    setError('');
    const result = await window.electronAPI.git.review(rootPath, {
      scope,
      target: scope === 'uncommitted' ? undefined : target,
    });
    if (!result.ok) {
      setError(result.error || t('reviewReadFailed'));
      setBusy(false);
      return;
    }
    if (!(result.diff || '').trim() && !(result.status || '').trim()) {
      setError(t('reviewNoChanges'));
      setBusy(false);
      return;
    }

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

    setReviewMode(true);
    closeReview();
    try {
      await sendMessage(prompt, selectedModel.providerId, selectedModel.id);
    } finally {
      useChatStore.getState().setReviewMode(false);
    }
  };

  const scopes: { value: ReviewScope; label: string; hint: string }[] = [
    { value: 'uncommitted', label: t('reviewUncommitted'), hint: t('reviewUncommittedHint') },
    { value: 'base', label: t('reviewBase'), hint: t('reviewBaseHint') },
    { value: 'commit', label: t('reviewCommit'), hint: t('reviewCommitHint') },
  ];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={closeReview} />
      <div className="fixed left-4 bottom-4 top-[96px] z-50 w-[380px] flex flex-col bg-[var(--bg-1)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <FiShield size={16} className="text-[var(--accent)]" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">{t('codeReview')}</div>
            <div className="text-[11px] text-[var(--text-muted)]">{t('reviewReadOnly')}</div>
          </div>
          <button onClick={closeReview} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)]">
            <FiX size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {!rootPath ? (
            <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)] text-center px-6">
              {t('reviewNeedsRepo')}
            </div>
          ) : (
            <>
              {scopes.map((item) => (
                <button key={item.value} onClick={() => setScope(item.value)}
                  className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors ${
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
                <select value={target} onChange={(event) => setTarget(event.target.value)}
                  className="w-full bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs outline-none focus:border-[var(--accent)]">
                  {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                </select>
              )}
              {scope === 'commit' && (
                <input value={target} onChange={(event) => setTarget(event.target.value)}
                  placeholder={t('reviewCommitPlaceholder')}
                  className="w-full bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs font-mono outline-none focus:border-[var(--accent)]" />
              )}
              {error && <div className="text-xs text-[var(--error)] whitespace-pre-wrap">{error}</div>}
            </>
          )}
        </div>

        {rootPath && (
          <div className="p-3 border-t border-[var(--border)]">
            <button onClick={() => void startReview()} disabled={busy || !selectedModel || (scope !== 'uncommitted' && !target.trim())}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-[var(--accent)] text-white text-xs font-semibold hover:bg-[var(--accent-hover)] disabled:opacity-40">
              <FiShield size={13} /> {busy ? t('reviewPreparing') : t('startReview')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
