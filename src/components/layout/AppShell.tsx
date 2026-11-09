import GithubPushDialog from '../plugins/GithubPushDialog';
import GithubReleaseDialog from '../plugins/GithubReleaseDialog';
import { useRef, useState, useEffect } from 'react';
import { useUIStore, useWorkspaceStore, useLanguageStore, useChatStore } from '../../stores';
import { useScreenshotStore } from '../../stores/screenshot.store';
import Sidebar from './Sidebar';
import SidebarReveal from './SidebarReveal';
import ChatView from '../chat/ChatView';
import RsiView from '../rsi/RsiView';
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
import ImageGeneratorModal from '../chat/ImageGeneratorModal';
import DshMarketPanel from '../dsh-market/DshMarketPanel';
import ResizeHandle from './ResizeHandle';
import { panelLayout, SIDEBAR_OVERLAY_WIDTH } from './panelLayout';
import { workbenchVisible } from './rsiLayout';

export default function AppShell() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const terminalOpen = useUIStore((s) => s.terminalOpen);
  const changedFilesOpen = useUIStore((s) => s.changedFilesOpen);
  const closeChangedFiles = useUIStore((s) => s.closeChangedFiles);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  useEffect(() => { closeChangedFiles(); }, [activeConversationId, closeChangedFiles]);
  const reviewOpen = useUIStore((s) => s.reviewOpen);
  const worktreesOpen = useUIStore((s) => s.worktreesOpen);
  const backgroundOpen = useUIStore((s) => s.backgroundOpen);
  const remoteOpen = useUIStore((s) => s.remoteOpen);
  const computerOpen = useUIStore((s) => s.computerOpen);
  const previewOpen = useUIStore((s) => s.previewOpen);
  const closePreview = useUIStore((s) => s.closePreview);
  const setWorkbenchTab = useUIStore((s) => s.setWorkbenchTab);
  const editorWidthPct = useUIStore((s) => s.editorWidthPct);
  const setEditorWidthPct = useUIStore((s) => s.setEditorWidthPct);
  const sidebarWidthPx = useUIStore((s) => s.sidebarWidthPx);
  const setSidebarWidthPx = useUIStore((s) => s.setSidebarWidthPx);
  const previewWidthPx = useUIStore((s) => s.previewWidthPx);
  const setPreviewWidthPx = useUIStore((s) => s.setPreviewWidthPx);
  const terminalHeightPx = useUIStore((s) => s.terminalHeightPx);
  const setTerminalHeightPx = useUIStore((s) => s.setTerminalHeightPx);
  // RSI owns the center column while its mode is armed: no transcript, no
  // composer — a dedicated console instead of the chat.
  const agentMode = useChatStore((s) => s.agentMode);
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        window.location.reload();
        return;
      }
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
  // RSI owns the entire center column: an open editor is hidden (never
  // cleared) while the loop runs, so the conversation is never squeezed.
  const workbenchOpen = workbenchVisible({ agentMode, selectedFile });
  const previewDockOpen = previewOpen;

  // Opening a file from the tree brings the code forward.
  useEffect(() => { if (selectedFile) setWorkbenchTab('code'); }, [selectedFile, setWorkbenchTab]);

  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const layout = panelLayout({
    ...viewport, sidebarOpen, sidebarWidth: sidebarWidthPx, previewOpen,
    previewWidth: previewWidthPx, editorOpen: workbenchOpen, terminalHeight: terminalHeightPx,
  });
  const editorUnits = () => {
    const rect = splitRef.current?.getBoundingClientRect();
    return 100 / Math.max(1, layout.stackedEditor ? (rect?.height ?? viewport.height) : (rect?.width ?? viewport.width));
  };
  const editorSpace = layout.stackedEditor ? viewport.height - (terminalOpen ? layout.terminal : 0) : layout.content;
  const editorMax = Math.min(80, Math.max(20, 100 * (1 - 320 / Math.max(1, editorSpace))));
  const editorSize = Math.min(editorWidthPct, editorMax);

  return (
    <div className="flex h-screen relative overflow-hidden bg-[var(--bg-0)] select-none">
      {/* Atmospheric ambient lighting behind glass layers */}
      <div className="ambient-glow-1" aria-hidden="true" />
      <div className="ambient-glow-2" aria-hidden="true" />

      <SidebarReveal open={sidebarOpen} width={layout.sidebar} overlay={viewport.width < SIDEBAR_OVERLAY_WIDTH}
        label={t('toggleSidebar')} onToggle={toggleSidebar}>
        <Sidebar />
        <ResizeHandle label={t('dragResizeWidth')} value={layout.sidebar} min={200} max={Math.min(480, Math.max(200, viewport.width - 48))} reset={260} onChange={setSidebarWidthPx}
          className="absolute inset-y-0 -right-[3px] w-[7px] cursor-col-resize z-30 flex justify-center" />
      </SidebarReveal>
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="flex-1 flex flex-col min-h-0">
          <div className="relative flex-1 flex min-h-0 min-w-0">
            <div ref={splitRef} className={`flex-1 flex min-w-0 min-h-0 ${layout.stackedEditor ? 'flex-col' : ''}`}>
            {workbenchOpen && (
              <>
                <div className="min-w-0 min-h-0 shrink-0 flex flex-col" style={layout.stackedEditor ? { height: `${editorSize}%` } : { width: `${editorSize}%` }}>
                  <div className="flex-1 min-h-0 relative">
                    {selectedFile && (
                      <div className="absolute inset-0">
                        <EditorPanel />
                      </div>
                    )}
                  </div>
                </div>
                <ResizeHandle label={layout.stackedEditor ? t('dragResizeHeight') : t('dragResizeWidth')}
                  value={editorSize} min={20} max={editorMax} reset={50} onChange={setEditorWidthPct}
                  horizontal={layout.stackedEditor} unitsPerPixel={editorUnits}
                  className={layout.stackedEditor ? 'relative h-[7px] -my-[3px] shrink-0 cursor-row-resize z-30 flex items-center' : 'relative w-[7px] -mx-[3px] shrink-0 cursor-col-resize z-30 flex justify-center'} />
              </>
            )}
            <div className="flex-1 flex flex-col min-w-0 min-h-0">
              {/* Slim window-drag strip: the chat column has no tab bar, so
                  without this the window can only be moved from the far left. */}
              <div className="h-7 shrink-0" style={{ WebkitAppRegion: 'drag' } as any} />
              {agentMode === 'rsi' ? <RsiView /> : <ChatView />}
            </div>
            </div>
            {/* Browser / project preview docks on the right of the chat. */}
            {previewDockOpen && (
              <>
                {layout.previewOverlay && <button aria-label={t('close')} onClick={closePreview} className="absolute inset-0 z-30 bg-black/25 backdrop-blur-sm" />}
                <div className={`${layout.previewOverlay ? 'absolute right-0 inset-y-0 z-40 shadow-2xl' : 'relative'} shrink-0 flex flex-col min-w-0 min-h-0 anim-message bg-[var(--bg-0)]`} style={{ width: layout.preview }}>
                  <ResizeHandle label={t('dragResizeWidth')} value={layout.preview} min={Math.min(280, layout.previewMax)} max={layout.previewMax} reset={480} onChange={setPreviewWidthPx} sign={-1}
                    className="absolute inset-y-0 -left-[3px] w-[7px] cursor-col-resize z-30 flex justify-center" />
                  <PreviewPanel />
                </div>
              </>
            )}
          </div>
          {terminalMounted && (
            <div className="relative shrink-0" style={{ height: terminalOpen ? layout.terminal : 0 }}>
              {terminalOpen && (
                <ResizeHandle label={t('dragResizeHeight')} value={layout.terminal} min={120} max={layout.terminalMax} reset={280} onChange={setTerminalHeightPx} horizontal sign={-1}
                  className="absolute -top-[3px] inset-x-0 h-[7px] cursor-row-resize z-30 flex items-center" />
              )}
              <div className={terminalOpen ? 'h-full' : 'hidden'}>
                <TerminalPanel />
              </div>
            </div>
          )}
        </div>
      </div>
      <GithubPushDialog />
      <GithubReleaseDialog />
      {settingsOpen && <SettingsModal />}
      {shotOpen && <ScreenshotOverlay />}
      {backgroundOpen && <BackgroundPanel />}
      {changedFilesOpen && <ChangedFilesPanel />}
      {reviewOpen && <CodeReviewPanel />}
      {worktreesOpen && <WorktreePanel />}
      {remoteOpen && <RemotePanel />}
      {computerOpen && <ComputerPanel />}
      <ImageGeneratorModal />
      <DshMarketPanel />
    </div>
  );
}
