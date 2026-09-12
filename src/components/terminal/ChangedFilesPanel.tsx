import { FiX, FiFolder, FiTrash2, FiEdit3, FiCopy, FiCornerUpRight, FiFilePlus } from 'react-icons/fi';
import type { ChangeKind } from '../../stores/codeChanges.store';
import { useCodeChangesStore, useWorkspaceStore, useUIStore, useLanguageStore } from '../../stores';

// Floating popover listing every file the agent has touched this session, in a
// single column. Toggled from the sidebar; click a row to open it in the editor.
export default function ChangedFilesPanel() {
  const changes = useCodeChangesStore((s) => s.changes);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const closeChangedFiles = useUIStore((s) => s.closeChangedFiles);
  const { t } = useLanguageStore();

  // File changes only (drop command/exec), newest first, deduped by path.
  const seen = new Set<string>();
  const files = changes
    .filter((c) => c.kind !== 'exec' && c.filePath !== '[Command]')
    .filter((c) => (seen.has(c.filePath) ? false : (seen.add(c.filePath), true)));

  const kindIcon = (kind: ChangeKind) => {
    switch (kind) {
      case 'delete': return <FiTrash2 size={12} />;
      case 'rename': return <FiCornerUpRight size={12} />;
      case 'copy': return <FiCopy size={12} />;
      case 'create': return <FiFilePlus size={12} />;
      default: return <FiEdit3 size={12} />;
    }
  };
  const statusColor = (status: string) =>
    status === 'applied' ? 'var(--success)'
      : status === 'failed' ? 'var(--error)'
        : status === 'reverted' ? 'var(--text-muted)'
          : 'var(--accent)';

  return (
    <>
      {/* Click-outside backdrop */}
      <div className="fixed inset-0 z-40" onClick={closeChangedFiles} />
      {/* Floating card */}
      <div className="fixed left-4 bottom-4 top-[96px] z-50 w-[300px] flex flex-col bg-[var(--bg-1)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-3.5 py-3 shrink-0">
          <FiFolder size={16} className="text-[var(--text-secondary)]" />
          <button onClick={closeChangedFiles}
            className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors">
            <FiX size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 pb-2">
          {files.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">{t('noChanges')}</div>
          ) : (
            files.map((c) => {
              const name = c.filePath.split('/').pop() || c.filePath;
              const active = selectedFile === c.filePath;
              return (
                <button
                  key={c.id}
                  onClick={() => selectFile(c.filePath)}
                  title={c.filePath}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] text-left transition-colors ${
                    active ? 'bg-[var(--bg-3)]' : 'hover:bg-[var(--bg-2)]'
                  }`}
                >
                  <span className="shrink-0" style={{ color: statusColor(c.status) }}>{kindIcon(c.kind)}</span>
                  <span className="flex-1 truncate text-[var(--text-primary)]">{name}</span>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor(c.status) }} />
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
