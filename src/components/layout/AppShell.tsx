import { useRef, useState, useEffect } from 'react';
import { FiMenu } from 'react-icons/fi';
import { useUIStore, useWorkspaceStore, useLanguageStore } from '../../stores';
import { useScreenshotStore } from '../../stores/screenshot.store';
import Sidebar from './Sidebar';
import ChatView from '../chat/ChatView';
import EditorPanel from '../editor/EditorPanel';
import PreviewPanel from '../preview/PreviewPanel';
import SettingsModal from '../provider/SettingsModal';
import TerminalPanel from '../terminal/TerminalPanel';
import ChangedFilesPanel from '../terminal/ChangedFilesPanel';
import RemotePanel from '../remote/RemotePanel';
import ComputerPanel from '../computer/ComputerPanel';
import CodeReviewPanel from '../review/CodeReviewPanel';
import WorktreePanel from '../worktree/WorktreePanel';
import BackgroundPanel from '../background/BackgroundPanel';
import ScreenshotOverlay from '../screenshot/ScreenshotOverlay';

export default function AppShell() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const terminalOpen = useUIStore((s) => s.terminalOpen);
  const changedFilesOpen = useUIStore((s) => s.changedFilesOpen);
  const reviewOpen = useUIStore((s) => s.reviewOpen);
  const worktreesOpen = useUIStore((s) => s.worktreesOpen);
  const backgroundOpen = useUIStore((s) => s.backgroundOpen);
  const remoteOpen = useUIStore((s) => s.remoteOpen);
  const computerOpen = useUIStore((s) => s.computerOpen);
  const previewOpen = useUIStore((s) => s.previewOpen);
  const workbenchTab = useUIStore((s) => s.workbenchTab);
  const setWorkbenchTab = useUIStore((s) => s.setWorkbenchTab);
  const editorWidthPct = useUIStore((s) => s.editorWidthPct);
  const setEditorWidthPct = useUIStore((s) => s.setEditorWidthPct);
  const sidebarWidthPx = useUIStore((s) => s.sidebarWidthPx);
  const setSidebarWidthPx = useUIStore((s) => s.setSidebarWidthPx);
  const previewWidthPx = useUIStore((s) => s.previewWidthPx);
  const setPreviewWidthPx = useUIStore((s) => s.setPreviewWidthPx);
  const terminalHeightPx = useUIStore((s) => s.terminalHeightPx);
  const setTerminalHeightPx = useUIStore((s) => s.setTerminalHeightPx);
  const shotOpen = useScreenshotStore((s) => s.open);
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const { t } = useLanguageStore();
  const splitRef = useRef<HTMLDivElement>(null);
  // Once the terminal is first opened, keep it mounted (hidden when collapsed)
  // so its shell sessions and tab numbering survive re-opening.
  const [terminalMounted, setTerminalMounted] = useState(false);
  useEffect(() => { if (terminalOpen) setTerminalMounted(true); }, [terminalOpen]);

  // VS Code-style sidebar toggle, available everywhere (the floating button is
  // easy to miss).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        // The screenshot overlay owns the keyboard while it is up.
        if (useScreenshotStore.getState().open) return;
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  // The left column is the code editor. The browser/preview docks on the RIGHT
  // so "open what we built" sits beside the chat — click-to-annotate then lands
  // in the composer without covering the transcript.
  const workbenchOpen = !!selectedFile;
  const previewDockOpen = previewOpen;

  // Opening a file from the tree brings the code forward.
  useEffect(() => { if (selectedFile) setWorkbenchTab('code'); }, [selectedFile, setWorkbenchTab]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitRef.current;
    if (!container) return;
    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      setEditorWidthPct(((ev.clientX - rect.left) / rect.width) * 100);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Pixel drag for sidebar / preview / terminal sizes (persisted in ui.store).
  const dragPixels = (
    e: React.MouseEvent,
    startPx: number,
    sign: number,
    apply: (px: number) => void,
    vertical = false,
  ) => {
    e.preventDefault();
    const startPos = vertical ? e.clientY : e.clientX;
    const onMove = (ev: MouseEvent) => {
      const delta = (vertical ? ev.clientY : ev.clientX) - startPos;
      apply(startPx + sign * delta);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="flex h-screen relative">
      {sidebarOpen && (
        <div className="relative shrink-0 flex min-h-0" style={{ width: sidebarWidthPx }}>
          <Sidebar />
          <div
            onMouseDown={(e) => dragPixels(e, sidebarWidthPx, 1, setSidebarWidthPx)}
            onDoubleClick={() => setSidebarWidthPx(260)}
            title="拖动调整宽度（双击复位）"
            className="group absolute top-0 bottom-0 -right-px w-[7px] cursor-col-resize z-30 flex justify-end"
          >
            <div className="w-px h-full bg-[var(--border)] group-hover:bg-[var(--accent)] transition-colors" />
            <div className="absolute inset-y-0 -left-2 -right-2" />
          </div>
        </div>
      )}
      {/* Floating sidebar reopen — no header rows anywhere, so the top blank
          is truly zero. Mid-left edge keeps it clear of the traffic lights. */}
      {!sidebarOpen && (
        <button onClick={toggleSidebar} title={t('toggleSidebar')}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-40 w-10 h-10 rounded-full bg-[var(--accent-soft)] backdrop-blur border border-[var(--accent)]/50 shadow-[0_4px_16px_rgba(0,0,0,0.18)] flex items-center justify-center text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white hover:border-[var(--accent)] transition-all">
          <FiMenu size={17} strokeWidth={2.5} />
        </button>
      )}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 flex flex-col min-h-0">
          <div ref={splitRef} className="flex-1 flex min-h-0">
            {workbenchOpen && (
              <>
                <div className="min-w-0 shrink-0 flex flex-col" style={{ width: `${editorWidthPct}%` }}>
                  <div className="flex-1 min-h-0 relative">
                    {/* visibility (not display:none) keeps the hidden panel's box
                        alive — a collapsed <webview> comes back blank. */}
                    {selectedFile && (
                      <div className="absolute inset-0">
                        <EditorPanel />
                      </div>
                    )}
                  </div>
                </div>
                <div
                  onMouseDown={startDrag}
                  onDoubleClick={() => setEditorWidthPct(50)}
                  title="拖动调整宽度（双击复位）"
                  className="group relative w-px shrink-0 cursor-col-resize bg-[var(--border)] hover:bg-[var(--accent)] transition-colors"
                >
                  <div className="absolute inset-y-0 -left-2 -right-2 z-10" />
                </div>
              </>
            )}
            <div className="flex-1 flex flex-col min-w-0">
              {/* Slim window-drag strip: the chat column has no tab bar, so
                  without this the window can only be moved from the far left. */}
              <div className="h-7 shrink-0" style={{ WebkitAppRegion: 'drag' } as any} />
              <ChatView />
            </div>
            {/* Browser / project preview docks on the right of the chat. */}
            {previewDockOpen && (
              <div className="relative shrink-0 flex flex-col min-w-0 anim-message" style={{ width: previewWidthPx }}>
                <div
                  onMouseDown={(e) => dragPixels(e, previewWidthPx, -1, setPreviewWidthPx)}
                  onDoubleClick={() => setPreviewWidthPx(480)}
                  title="拖动调整宽度（双击复位）"
                  className="group absolute top-0 bottom-0 -left-px w-[7px] cursor-col-resize z-30 flex"
                >
                  <div className="w-px h-full bg-[var(--border)] group-hover:bg-[var(--accent)] transition-colors" />
                  <div className="absolute inset-y-0 -left-2 -right-2" />
                </div>
                <PreviewPanel />
              </div>
            )}
          </div>
          {terminalMounted && (
            <div className="relative shrink-0" style={{ height: terminalOpen ? terminalHeightPx : 0 }}>
              {terminalOpen && (
                <div
                  onMouseDown={(e) => dragPixels(e, terminalHeightPx, -1, setTerminalHeightPx, true)}
                  onDoubleClick={() => setTerminalHeightPx(280)}
                  title="拖动调整高度（双击复位）"
                  className="group absolute top-0 inset-x-0 h-[7px] cursor-row-resize z-30 flex flex-col items-center"
                >
                  <div className="h-px w-full bg-[var(--border)] group-hover:bg-[var(--accent)] transition-colors" />
                  <div className="absolute inset-x-0 -top-1 -bottom-1" />
                </div>
              )}
              <div className={terminalOpen ? 'h-full' : 'hidden'}>
                <TerminalPanel />
              </div>
            </div>
          )}
        </div>
      </div>
      {settingsOpen && <SettingsModal />}
      {shotOpen && <ScreenshotOverlay />}
      {backgroundOpen && <BackgroundPanel />}
      {changedFilesOpen && <ChangedFilesPanel />}
      {reviewOpen && <CodeReviewPanel />}
      {worktreesOpen && <WorktreePanel />}
      {remoteOpen && <RemotePanel />}
      {computerOpen && <ComputerPanel />}
    </div>
  );
}
