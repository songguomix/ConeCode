/** Below this width the sidebar floats above the workspace instead of docking. */
export const SIDEBAR_OVERLAY_WIDTH = 760;

/** Fit the workbench without overwriting the user's saved panel sizes. */
export function panelLayout({ width, height, sidebarOpen, sidebarWidth, previewOpen, previewWidth, editorOpen, terminalHeight }: {
  width: number; height: number; sidebarOpen: boolean; sidebarWidth: number;
  previewOpen: boolean; previewWidth: number; editorOpen: boolean; terminalHeight: number;
}) {
  const sidebarOverlay = sidebarOpen && width < SIDEBAR_OVERLAY_WIDTH;
  const sidebar = Math.min(sidebarWidth, Math.max(200, width - 48));
  const workspace = Math.max(0, width - (sidebarOpen && !sidebarOverlay ? sidebar : 0));
  const previewOverlay = previewOpen && workspace < (editorOpen ? 960 : 680);
  const previewMax = Math.min(720, previewOverlay ? Math.max(0, workspace - 48) : Math.max(280, workspace - (editorOpen ? 640 : 360)));
  const preview = Math.min(previewWidth, previewMax);
  const content = Math.max(0, workspace - (previewOpen && !previewOverlay ? preview : 0));
  const stackedEditor = editorOpen && content < 640;
  return {
    sidebarOverlay, sidebar, previewOverlay, preview, previewMax, content,
    stackedEditor,
    terminalMax: Math.min(640, Math.max(120, height - (stackedEditor ? 480 : 320))),
    terminal: Math.min(terminalHeight, Math.max(120, height - (stackedEditor ? 480 : 320))),
  };
}
