import { useRef, useState, useEffect } from 'react';
import { FiMenu } from 'react-icons/fi';
import { useUIStore, useWorkspaceStore } from '../../stores';
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

export default function AppShell() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const terminalOpen = useUIStore((s) => s.terminalOpen);
  const changedFilesOpen = useUIStore((s) => s.changedFilesOpen);
  const reviewOpen = useUIStore((s) => s.reviewOpen);
  const worktreesOpen = useUIStore((s) => s.worktreesOpen);
  const remoteOpen = useUIStore((s) => s.remoteOpen);
  const computerOpen = useUIStore((s) => s.computerOpen);
  const previewOpen = useUIStore((s) => s.previewOpen);
  const workbenchTab = useUIStore((s) => s.workbenchTab);
  const setWorkbenchTab = useUIStore((s) => s.setWorkbenchTab);
  const editorWidthPct = useUIStore((s) => s.editorWidthPct);
  const setEditorWidthPct = useUIStore((s) => s.setEditorWidthPct);
  const selectedFile = useWorkspaceStore((s) => s.selectedFile);
  const splitRef = useRef<HTMLDivElement>(null);
  // Once the terminal is first opened, keep it mounted (hidden when collapsed)
  // so its shell sessions and tab numbering survive re-opening.
  const [terminalMounted, setTerminalMounted] = useState(false);
  useEffect(() => { if (terminalOpen) setTerminalMounted(true); }, [terminalOpen]);

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

  return (
    <div className="flex h-screen">
      {sidebarOpen && <Sidebar />}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 flex flex-col min-h-0">
          <div ref={splitRef} className="flex-1 flex min-h-0">
            {workbenchOpen && (
              <>
                <div className="min-w-0 shrink-0 flex flex-col" style={{ width: `${editorWidthPct}%` }}>
                  {/* Sidebar-closed: the workbench sits top-left, so it needs its
                      own traffic-light clearance + menu above it. */}
                  {!sidebarOpen && (
                    <div className="bg-[var(--bg-0)] shrink-0" style={{ WebkitAppRegion: 'drag' } as any}>
                      <div className="h-[58px]" />
                      <div className="flex items-center px-3 pb-2">
                        <button onClick={toggleSidebar} style={{ WebkitAppRegion: 'no-drag' } as any}
                          className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-3)] hover:text-[var(--text-primary)] transition-colors">
                          <FiMenu size={16} />
                        </button>
                      </div>
                    </div>
                  )}
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
              {/* Top drag strip / traffic-light clearance for the chat column.
                  Taller only when it hosts the menu button under the traffic
                  lights (sidebar closed, nothing in the workbench on the left). */}
              {!sidebarOpen && !workbenchOpen ? (
                <div className="bg-[var(--bg-0)] shrink-0" style={{ WebkitAppRegion: 'drag' } as any}>
                  <div className="h-[58px]" />
                  <div className="flex items-center px-3 pb-2">
                    <button onClick={toggleSidebar} style={{ WebkitAppRegion: 'no-drag' } as any}
                      className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-3)] hover:text-[var(--text-primary)] transition-colors">
                      <FiMenu size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="h-[52px] bg-[var(--bg-0)] shrink-0" style={{ WebkitAppRegion: 'drag' } as any} />
              )}
              <ChatView />
            </div>
            {/* Browser / project preview docks on the right of the chat. */}
            {previewDockOpen && (
              <div className="w-[42%] min-w-[280px] max-w-[560px] shrink-0 flex flex-col border-l border-[var(--border)] anim-message">
                <PreviewPanel />
              </div>
            )}
          </div>
          {terminalMounted && (
            <div className={terminalOpen ? 'h-[280px] shrink-0' : 'hidden'}>
              <TerminalPanel />
            </div>
          )}
        </div>
      </div>
      {settingsOpen && <SettingsModal />}
      {changedFilesOpen && <ChangedFilesPanel />}
      {reviewOpen && <CodeReviewPanel />}
      {worktreesOpen && <WorktreePanel />}
      {remoteOpen && <RemotePanel />}
      {computerOpen && <ComputerPanel />}
    </div>
  );
}
