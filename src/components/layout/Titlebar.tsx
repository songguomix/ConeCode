import { useEffect, useState } from 'react';
import { FiMinus, FiSquare, FiX, FiGitBranch } from 'react-icons/fi';
import { useWorkspaceStore, useChatStore, useLanguageStore } from '../../stores';

interface GitInfo { isRepo: boolean; branch: string | null; dirty: number; }

export default function Titlebar() {
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const { t } = useLanguageStore();
  const [git, setGit] = useState<GitInfo>({ isRepo: false, branch: null, dirty: 0 });

  // Refresh branch + dirty count when the folder changes or the agent finishes a
  // turn (which may have edited files / committed).
  useEffect(() => {
    let cancelled = false;
    if (!rootPath) { setGit({ isRepo: false, branch: null, dirty: 0 }); return; }
    window.electronAPI.git.info(rootPath).then((info: GitInfo) => { if (!cancelled) setGit(info); }).catch(() => {});
    return () => { cancelled = true; };
  }, [rootPath, isStreaming]);

  return (
    <div className="h-8 bg-[var(--bg-1)] border-b border-[var(--border)] flex items-center justify-between px-2 select-none"
      style={{ WebkitAppRegion: 'drag' } as any}>
      {/* Left: git branch (cleared past the macOS traffic lights) */}
      <div className="flex items-center pl-[72px]">
        {git.isRepo && git.branch && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]" title={`${t('gitBranch')}: ${git.branch}`}>
            <FiGitBranch size={11} />
            <span className="font-medium text-[var(--text-secondary)]">{git.branch}</span>
            <span>{git.dirty > 0 ? `·${git.dirty}` : `· ${t('gitClean')}`}</span>
          </span>
        )}
      </div>

      <div className="flex gap-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <button onClick={() => window.electronAPI.window.minimize()}
          className="w-7 h-6 flex items-center justify-center rounded hover:bg-[var(--bg-3)] text-[var(--text-muted)]">
          <FiMinus size={12} />
        </button>
        <button onClick={() => window.electronAPI.window.maximize()}
          className="w-7 h-6 flex items-center justify-center rounded hover:bg-[var(--bg-3)] text-[var(--text-muted)]">
          <FiSquare size={10} />
        </button>
        <button onClick={() => window.electronAPI.window.close()}
          className="w-7 h-6 flex items-center justify-center rounded hover:bg-red-500/20 text-[var(--error)]">
          <FiX size={13} />
        </button>
      </div>
    </div>
  );
}
