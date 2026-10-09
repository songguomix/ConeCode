import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FiFile, FiMonitor, FiX, FiPlus } from 'react-icons/fi';
import { useUIStore, useWorkspaceStore, useLanguageStore, usePreviewStore, useAiHighlightsStore } from '../../stores';

// Native traffic lights float over the top-left on macOS (Electron
// trafficLightPosition x:14 y:12 ≈ 60px wide), so the tab strip needs a left
// pad to keep its first tab clickable when no sidebar covers them. Other
// platforms get a true zero.
const IS_MAC = typeof navigator !== 'undefined' &&
  (/Mac/.test(navigator.platform || '') || /Macintosh/.test(navigator.userAgent || ''));

// The tab strip at the top of the left-hand workbench column: one tab per open
// editor plus the preview. Tabs scroll horizontally like VS Code; each file tab
// carries its own dirty dot and AI-changes dot.

interface Props {
  active: 'code' | 'preview';
  /** Secondary text between the tabs and the actions (file path, page title…). */
  subtitle?: string;
  /** Panel-specific buttons, right-aligned. */
  actions?: ReactNode;
}

export default function WorkbenchTabs({ active, subtitle, actions }: Props) {
  const openTabs = useWorkspaceStore((s) => s.openTabs);
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const dirtyTabs = useWorkspaceStore((s) => s.dirtyTabs);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const closeOtherTabs = useWorkspaceStore((s) => s.closeOtherTabs);
  const closeAllTabs = useWorkspaceStore((s) => s.closeAllTabs);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const aiLines = useAiHighlightsStore((s) => s.lines);
  const previewOpen = useUIStore((s) => s.previewOpen);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const closePreview = useUIStore((s) => s.closePreview);
  const setWorkbenchTab = useUIStore((s) => s.setWorkbenchTab);
  const previewState = usePreviewStore((s) => s.state);
  const { t } = useLanguageStore();
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Keep the active tab scrolled into view.
  useEffect(() => {
    stripRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedFile, openTabs.length]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

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
      className="flex items-center bg-[var(--bg-1)] border-b border-[var(--border)] shrink-0 min-w-0"
      style={{ WebkitAppRegion: 'drag', ...(!sidebarOpen && IS_MAC ? { paddingLeft: 74 } : null) } as any}
    >
      <div ref={stripRef} className="flex items-center shrink min-w-0 overflow-x-auto" role="tablist" style={{ WebkitAppRegion: 'no-drag' } as any}>
        {openTabs.map((path) => {
          const name = path.split('/').pop() || path;
          const isActive = active === 'code' && selectedFile === path;
          const dirty = !!dirtyTabs[path];
          const ai = (aiLines[path]?.length ?? 0) > 0;
          return (
            <Tab
              key={path}
              active={isActive}
              title={path}
              label={name}
              closeLabel={t('close')}
              icon={<FiFile size={13} className={isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />}
              badge={
                <span className="flex items-center gap-1 shrink-0">
                  {ai && <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" title={t('aiChanges')} />}
                  {dirty && <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)]" title={t('unsaved')} />}
                </span>
              }
              showClose={!dirty}
              onSelect={() => { void selectFile(path); setWorkbenchTab('code'); }}
              onClose={() => void closeTab(path)}
              onMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, path }); }}
            />
          );
        })}

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

      <span className="flex-1 truncate px-3 text-[11px] text-[var(--text-muted)] min-w-[40px]">{subtitle}</span>

      {actions && (
        <div className="flex items-center gap-1 px-2 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as any}>
          {actions}
        </div>
      )}

      {menu && (
        <div onClick={(e) => e.stopPropagation()}
          className="fixed z-50 w-[190px] rounded-xl border border-[var(--border)] bg-[var(--bg-2)] shadow-xl py-1 overflow-hidden"
          style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 160) }}>
          <MenuBtn label={t('close')} onClick={() => { void closeTab(menu.path); setMenu(null); }} />
          <MenuBtn label={t('closeOthers')} onClick={() => { void closeOtherTabs(menu.path); setMenu(null); }} />
          <MenuBtn label={t('closeAll')} onClick={() => { closeAllTabs(); setMenu(null); }} />
          <MenuBtn label={t('copyPath')} onClick={() => { void navigator.clipboard.writeText(menu.path).catch(() => {}); setMenu(null); }} />
        </div>
      )}
    </div>
  );
}

function MenuBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="w-full text-left px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-colors">
      {label}
    </button>
  );
}

// The label and the × are separate buttons (nesting them would be invalid), so
// the wrapper carries the tab's chrome and the hover state that reveals the ×.
function Tab({ active, icon, label, badge, title, closeLabel, onSelect, onClose, onMenu, showClose = true }: {
  active: boolean;
  icon: ReactNode;
  label: string;
  badge?: ReactNode;
  title?: string;
  closeLabel: string;
  onSelect: () => void;
  onClose: () => void;
  onMenu?: (e: React.MouseEvent) => void;
  showClose?: boolean;
}) {
  return (
    <div
      title={title}
      data-active={active}
      onContextMenu={onMenu}
      className={`group flex items-center gap-2 pl-3 pr-2 py-1.5 border-r border-[var(--border)] text-[13px] transition-colors shrink-0 ${
        active
          ? 'bg-[var(--bg-0)] border-t-2 border-t-[var(--accent)] text-[var(--text-primary)] font-medium'
          : 'border-t-2 border-t-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-0)]/60'
      }`}
    >
      <button role="tab" aria-selected={active} onClick={onSelect} className="flex items-center gap-2 min-w-0 outline-none">
        {icon}
        <span className="truncate max-w-[160px]">{label}</span>
        {badge}
      </button>
      {showClose ? (
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
      ) : (
        <span className="w-[18px] shrink-0" />
      )}
    </div>
  );
}
