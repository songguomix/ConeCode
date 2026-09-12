import type { ReactNode } from 'react';
import { FiFile, FiMonitor, FiX, FiPlus } from 'react-icons/fi';
import { useUIStore, useWorkspaceStore, useLanguageStore, usePreviewStore } from '../../stores';

// The tab strip at the top of the left-hand workbench column. The editor and the
// preview each render it above their own body (both panels stay mounted, so the
// webview isn't torn down when you flip to the code), which is why it lives here
// instead of inside either one.

interface Props {
  active: 'code' | 'preview';
  /** Secondary text between the tabs and the actions (file path, page title…). */
  subtitle?: string;
  /** Panel-specific buttons, right-aligned. */
  actions?: ReactNode;
}

export default function WorkbenchTabs({ active, subtitle, actions }: Props) {
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const closeFile = useWorkspaceStore((s) => s.closeFile);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const previewOpen = useUIStore((s) => s.previewOpen);
  const closePreview = useUIStore((s) => s.closePreview);
  const setWorkbenchTab = useUIStore((s) => s.setWorkbenchTab);
  const editorDirty = useUIStore((s) => s.editorDirty);
  const previewState = usePreviewStore((s) => s.state);
  const { t } = useLanguageStore();

  const fileName = selectedFile ? selectedFile.split('/').pop() || selectedFile : null;

  // Swap the open file without leaving the conversation — the sidebar tree only
  // reaches files under an opened folder, and this also takes anything else.
  const openFile = async () => {
    const picked = await window.electronAPI.dialog.openFile();
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) {
      await selectFile(path);
      setWorkbenchTab('code');
    }
  };

  return (
    <div
      className="flex items-center bg-[var(--bg-1)] border-b border-[var(--border)] shrink-0"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      <div className="flex items-center shrink-0" role="tablist" style={{ WebkitAppRegion: 'no-drag' } as any}>
        {fileName && (
          <Tab
            active={active === 'code'}
            title={selectedFile || ''}
            label={fileName}
            closeLabel={t('close')}
            icon={<FiFile size={13} className={active === 'code' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />}
            badge={editorDirty ? <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] shrink-0" title={t('unsaved')} /> : null}
            onSelect={() => setWorkbenchTab('code')}
            onClose={closeFile}
          />
        )}

        {previewOpen && (
          <Tab
            active={active === 'preview'}
            label={t('preview')}
            closeLabel={t('close')}
            icon={<FiMonitor size={13} className={active === 'preview' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />}
            badge={
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  previewState === 'running' ? 'bg-[var(--success)]'
                  : previewState === 'starting' ? 'bg-[var(--warning)] animate-pulse'
                  : previewState === 'error' ? 'bg-[var(--error)]'
                  : 'bg-[var(--text-muted)]'
                }`}
              />
            }
            onSelect={() => setWorkbenchTab('preview')}
            onClose={closePreview}
          />
        )}

        <button
          onClick={openFile}
          title={t('openFile')}
          aria-label={t('openFile')}
          className="w-7 h-7 ml-1 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors shrink-0"
        >
          <FiPlus size={14} />
        </button>
      </div>

      <span className="flex-1 truncate px-3 text-[11px] text-[var(--text-muted)]">{subtitle}</span>

      {actions && (
        <div className="flex items-center gap-1 px-2 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as any}>
          {actions}
        </div>
      )}
    </div>
  );
}

// The label and the × are separate buttons (nesting them would be invalid), so
// the wrapper carries the tab's chrome and the hover state that reveals the ×.
function Tab({ active, icon, label, badge, title, closeLabel, onSelect, onClose }: {
  active: boolean;
  icon: ReactNode;
  label: string;
  badge?: ReactNode;
  title?: string;
  closeLabel: string;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      title={title}
      className={`group flex items-center gap-2 pl-3 pr-2 py-1.5 border-r border-[var(--border)] text-[13px] transition-colors ${
        active
          ? 'bg-[var(--bg-0)] border-t-2 border-t-[var(--accent)] text-[var(--text-primary)] font-medium'
          : 'border-t-2 border-t-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-0)]/60'
      }`}
    >
      <button role="tab" aria-selected={active} onClick={onSelect} className="flex items-center gap-2 min-w-0 outline-none">
        {icon}
        <span className="truncate max-w-[180px]">{label}</span>
        {badge}
      </button>
      <button
        onClick={onClose}
        title={closeLabel}
        aria-label={closeLabel}
        // Always offered on the tab you are looking at — closing the open file
        // should not depend on discovering a hover state.
        className={`p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] focus:opacity-100 transition-opacity ${
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <FiX size={12} />
      </button>
    </div>
  );
}
