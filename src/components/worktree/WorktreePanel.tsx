import { useEffect, useRef, useState } from 'react';
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
  const request = useRef(0);
  const busyRef = useRef(false);
  const isCurrent = (id: number, root: string) => request.current === id && useWorkspaceStore.getState().rootPath === root;

  const load = async (root: string, id: number) => {
    const [list, refs] = await Promise.all([
      window.electronAPI.worktree.list(root),
      window.electronAPI.git.branches(root),
    ]);
    if (!isCurrent(id, root)) return;
    if (!list.ok) throw new Error(list.error || t('worktreeLoadFailed'));
    setWorktrees(list.worktrees || []);
    setBranches(refs);
    setRef((current) => current !== 'HEAD' && refs.includes(current) ? current : refs.find((item) => item === 'main') || refs.find((item) => item === 'master') || 'HEAD');
  };

  const run = async (action: (root: string, id: number) => Promise<void>, fallback: string) => {
    if (!rootPath || busyRef.current) return;
    const root = rootPath;
    const id = ++request.current;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action(root, id);
    } catch (cause) {
      if (isCurrent(id, root)) setError(cause instanceof Error ? cause.message : fallback);
    } finally {
      if (isCurrent(id, root)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const refresh = () => run(load, t('worktreeLoadFailed'));

  useEffect(() => {
    request.current++;
    busyRef.current = false;
    setBusy(false);
    setWorktrees([]);
    setBranches([]);
    setRef('HEAD');
    setName('');
    setError('');
    setConfirmRemove(null);
    void refresh();
    return () => { request.current++; };
  }, [rootPath]);

  const create = () => run(async (root, id) => {
    const result = await window.electronAPI.worktree.create(root, { ref, name: name.trim() });
    if (!isCurrent(id, root)) return;
    if (!result.ok) throw new Error(result.error || t('worktreeCreateFailed'));
    setName('');
    await load(root, id);
  }, t('worktreeCreateFailed'));

  const open = async (worktreePath: string) => {
    if (!rootPath || busyRef.current) return;
    const id = ++request.current;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const conversationId = useChatStore.getState().activeConversationId;
    try {
      if (await openFolderPath(worktreePath)) {
        if (useChatStore.getState().activeConversationId !== conversationId || useWorkspaceStore.getState().rootPath !== worktreePath) return;
        await setConversationFolder(worktreePath);
        if (useChatStore.getState().activeConversationId === conversationId && useWorkspaceStore.getState().rootPath === worktreePath) closeWorktrees();
      } else if (isCurrent(id, rootPath)) setError(t('worktreeOpenFailed'));
    } catch (cause) {
      if (isCurrent(id, rootPath)) setError(cause instanceof Error ? cause.message : t('worktreeOpenFailed'));
    } finally {
      if (request.current === id) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const remove = (worktreePath: string) => run(async (root, id) => {
    const result = await window.electronAPI.worktree.remove(root, worktreePath);
    if (!isCurrent(id, root)) return;
    if (!result.ok) throw new Error(result.error || t('worktreeRemoveFailed'));
    setConfirmRemove(null);
    await load(root, id);
  }, t('worktreeRemoveFailed'));

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-xs" onClick={closeWorktrees} />
      <div className="fixed left-4 bottom-4 top-[96px] z-50 w-[420px] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-112px)] flex flex-col bg-[var(--glass-surface)] backdrop-blur-2xl border border-[var(--glass-border)] rounded-2xl shadow-2xl overflow-hidden anim-menu ring-1 ring-black/5 dark:ring-white/10">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--glass-border)] shrink-0">
          <FiGitBranch size={16} className="text-[var(--accent)]" />
          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] font-serif font-bold text-[var(--text-primary)] tracking-tight">{t('worktrees')}</div>
            <div className="text-[11px] text-[var(--text-muted)]">{t('worktreesHint')}</div>
          </div>
          <button onClick={() => void refresh()} disabled={busy || !rootPath} aria-label={t('refresh')} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed transition-colors">
            <FiRefreshCw size={14} className={busy ? 'animate-spin' : ''} />
          </button>
          <button onClick={closeWorktrees} aria-label={t('close')} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)] cursor-pointer transition-colors">
            <FiX size={15} />
          </button>
        </div>

        <div className="p-3 border-b border-[var(--glass-border)] space-y-2 shrink-0">
          <div className="grid grid-cols-2 gap-2">
            <select value={ref} onChange={(event) => setRef(event.target.value)} disabled={!rootPath || busy} aria-label={t('reviewBase')}
              className="min-w-0 bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-2.5 py-2 text-xs outline-none focus:border-[var(--accent)] disabled:opacity-40">
              <option value="HEAD">HEAD</option>
              {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </select>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('worktreeName')} aria-label={t('worktreeName')} disabled={busy || !rootPath}
              className="min-w-0 bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-2.5 py-2 text-xs outline-none focus:border-[var(--accent)] disabled:opacity-40" />
          </div>
          <button onClick={() => void create()} disabled={busy || !rootPath}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[var(--accent)] text-white text-xs font-semibold hover:bg-[var(--accent-hover)] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed transition-all">
            <FiPlus size={13} /> {t('createWorktree')}
          </button>
          {!rootPath && <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-3 text-xs leading-relaxed text-[var(--text-muted)]">{t('worktreeNeedsRepo')}</div>}
          {error && <div role="alert" className="text-xs text-[var(--error)] whitespace-pre-wrap break-words">{error}</div>}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
          {worktrees.map((item) => {
            const current = item.path === rootPath;
            const removing = confirmRemove === item.path;
            return (
              <div key={item.path} className={`rounded-xl border px-3 py-2 ${current ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent-soft)_50%,transparent)]' : 'border-[var(--border)] bg-[var(--bg-2)]'}`}>
                <div className="flex items-start gap-2">
                  <FiFolder size={13} className="mt-0.5 text-[var(--text-muted)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="max-w-full text-xs font-semibold truncate">{item.branch || t('detachedHead')}</span>
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
                      <button onClick={() => void open(item.path)} disabled={busy} className="px-2 py-1 rounded-lg text-[11px] bg-[var(--bg-3)] hover:bg-[var(--bg-4)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors">{t('open')}</button>
                      {item.managed && (
                        <button onClick={() => setConfirmRemove(item.path)} disabled={busy} aria-label={t('delete')} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-3)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                          <FiTrash2 size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {removing && (
                  <div className="mt-2 pt-2 border-t border-[var(--border)] flex items-center gap-2">
                    <span className="text-[11px] text-[var(--text-muted)] flex-1">{t('removeWorktreeConfirm')}</span>
                    <button onClick={() => void remove(item.path)} disabled={busy} className="px-2 py-1 rounded-lg text-[11px] text-[var(--error)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] cursor-pointer disabled:cursor-not-allowed transition-colors">{t('delete')}</button>
                    <button onClick={() => setConfirmRemove(null)} className="px-2 py-1 rounded-lg text-[11px] bg-[var(--bg-3)] cursor-pointer hover:bg-[var(--bg-4)] transition-colors">{t('cancel')}</button>
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
