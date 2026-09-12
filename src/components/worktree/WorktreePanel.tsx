import { useEffect, useState } from 'react';
import { FiGitBranch, FiPlus, FiRefreshCw, FiTrash2, FiX, FiFolder } from 'react-icons/fi';
import type { GitWorktree } from '../../types/ipc.types';
import { useChatStore, useLanguageStore, useUIStore, useWorkspaceStore } from '../../stores';

export default function WorktreePanel() {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const openFolderPath = useWorkspaceStore((state) => state.openFolderPath);
  const setConversationFolder = useChatStore((state) => state.setConversationFolder);
  const closeWorktrees = useUIStore((state) => state.closeWorktrees);
  const { t } = useLanguageStore();
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [ref, setRef] = useState('HEAD');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const refresh = async () => {
    if (!rootPath) return;
    setBusy(true);
    setError('');
    const [list, refs] = await Promise.all([
      window.electronAPI.worktree.list(rootPath),
      window.electronAPI.git.branches(rootPath),
    ]);
    if (!list.ok) setError(list.error || t('worktreeLoadFailed'));
    setWorktrees(list.worktrees || []);
    setBranches(refs);
    if (ref === 'HEAD') {
      const preferred = refs.find((item) => item === 'main') || refs.find((item) => item === 'master');
      if (preferred) setRef(preferred);
    }
    setBusy(false);
  };

  useEffect(() => { void refresh(); }, [rootPath]);

  const create = async () => {
    if (!rootPath) return;
    setBusy(true);
    setError('');
    const result = await window.electronAPI.worktree.create(rootPath, { ref, name });
    if (!result.ok) setError(result.error || t('worktreeCreateFailed'));
    else setName('');
    await refresh();
  };

  const open = async (worktreePath: string) => {
    if (await openFolderPath(worktreePath)) {
      await setConversationFolder(worktreePath);
      closeWorktrees();
    } else {
      setError(t('worktreeOpenFailed'));
    }
  };

  const remove = async (worktreePath: string) => {
    if (!rootPath) return;
    setBusy(true);
    setError('');
    const result = await window.electronAPI.worktree.remove(rootPath, worktreePath);
    if (!result.ok) setError(result.error || t('worktreeRemoveFailed'));
    setConfirmRemove(null);
    await refresh();
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={closeWorktrees} />
      <div className="fixed left-4 bottom-4 top-[96px] z-50 w-[420px] flex flex-col bg-[var(--bg-1)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <FiGitBranch size={16} className="text-[var(--accent)]" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">{t('worktrees')}</div>
            <div className="text-[11px] text-[var(--text-muted)]">{t('worktreesHint')}</div>
          </div>
          <button onClick={() => void refresh()} disabled={busy} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)] disabled:opacity-40">
            <FiRefreshCw size={14} className={busy ? 'animate-spin' : ''} />
          </button>
          <button onClick={closeWorktrees} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)]">
            <FiX size={15} />
          </button>
        </div>

        <div className="p-3 border-b border-[var(--border)] space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <select value={ref} onChange={(event) => setRef(event.target.value)} disabled={!rootPath}
              className="bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-2.5 py-2 text-xs outline-none focus:border-[var(--accent)] disabled:opacity-40">
              <option value="HEAD">HEAD</option>
              {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </select>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('worktreeName')}
              className="bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-2.5 py-2 text-xs outline-none focus:border-[var(--accent)]" />
          </div>
          <button onClick={() => void create()} disabled={busy || !rootPath}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[var(--accent)] text-white text-xs font-semibold hover:bg-[var(--accent-hover)] disabled:opacity-40">
            <FiPlus size={13} /> {t('createWorktree')}
          </button>
          {!rootPath && <div className="text-xs text-[var(--text-muted)] text-center">{t('worktreeNeedsRepo')}</div>}
          {error && <div className="text-xs text-[var(--error)] whitespace-pre-wrap">{error}</div>}
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {worktrees.map((item) => {
            const current = item.path === rootPath;
            const removing = confirmRemove === item.path;
            return (
              <div key={item.path} className={`rounded-xl border px-3 py-2 ${current ? 'border-[var(--accent)] bg-[var(--accent-soft)]/50' : 'border-[var(--border)] bg-[var(--bg-2)]'}`}>
                <div className="flex items-start gap-2">
                  <FiFolder size={13} className="mt-0.5 text-[var(--text-muted)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold truncate">{item.branch || t('detachedHead')}</span>
                      {current && <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent)] text-white">{t('current')}</span>}
                      {item.isMain && <span className="text-[9px] text-[var(--text-muted)]">{t('localCheckout')}</span>}
                    </div>
                    <div className="text-[10px] font-mono text-[var(--text-muted)] truncate" title={item.path}>{item.path}</div>
                    <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                      {item.head.slice(0, 8)} · {item.dirty ? `${item.dirty} ${t('uncommitted')}` : t('gitClean')}
                    </div>
                  </div>
                  {!current && !removing && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => void open(item.path)} className="px-2 py-1 rounded-lg text-[11px] bg-[var(--bg-3)] hover:bg-[var(--bg-4)]">{t('open')}</button>
                      {item.managed && (
                        <button onClick={() => setConfirmRemove(item.path)} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-3)]">
                          <FiTrash2 size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {removing && (
                  <div className="mt-2 pt-2 border-t border-[var(--border)] flex items-center gap-2">
                    <span className="text-[11px] text-[var(--text-muted)] flex-1">{t('removeWorktreeConfirm')}</span>
                    <button onClick={() => void remove(item.path)} disabled={busy} className="px-2 py-1 rounded-lg text-[11px] text-[var(--error)] bg-[var(--error)]/10">{t('delete')}</button>
                    <button onClick={() => setConfirmRemove(null)} className="px-2 py-1 rounded-lg text-[11px] bg-[var(--bg-3)]">{t('cancel')}</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
