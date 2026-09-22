import { create } from 'zustand';

// Width of the editor panel (as a % of the editor+chat split) when a file is
// open. Persisted so the user's chosen split survives restarts. Clamped so
// neither panel can be dragged shut.
const EDITOR_WIDTH_KEY = 'conecode.editorWidthPct';
const DEFAULT_EDITOR_WIDTH = 50;
export const clampEditorWidth = (n: number) => Math.min(80, Math.max(20, n));

function loadEditorWidth(): number {
  try {
    const v = Number(localStorage.getItem(EDITOR_WIDTH_KEY));
    if (Number.isFinite(v) && v > 0) return clampEditorWidth(v);
  } catch {}
  return DEFAULT_EDITOR_WIDTH;
}

// Sidebar file tree stays open by default so folders remain browsable; the
// choice is remembered so Codex-style chat-first layouts persist across restarts.
const FILE_TREE_OPEN_KEY = 'conecode.fileTreeOpen';

function loadFileTreeOpen(): boolean {
  try {
    const raw = localStorage.getItem(FILE_TREE_OPEN_KEY);
    if (raw == null) return true;
    return raw !== '0';
  } catch {}
  return true;
}

/** The left column shows one of these at a time; both stay mounted. */
export type WorkbenchTab = 'code' | 'preview';

interface UIStore {
  sidebarOpen: boolean;
  settingsOpen: boolean;
  modelSelectorOpen: boolean;
  terminalOpen: boolean;
  changedFilesOpen: boolean;
  reviewOpen: boolean;
  worktreesOpen: boolean;
  remoteOpen: boolean;
  previewOpen: boolean;
  computerOpen: boolean;
  workbenchTab: WorkbenchTab;
  /** Editor has unsaved edits — surfaced as a dot on the code tab. */
  editorDirty: boolean;
  inputContent: string;
  editorWidthPct: number;
  /** Sidebar file tree section expanded (persisted). */
  fileTreeOpen: boolean;
  toggleSidebar: () => void;
  toggleFileTree: () => void;
  toggleSettings: () => void;
  toggleModelSelector: () => void;
  closeModelSelector: () => void;
  toggleTerminal: () => void;
  toggleChangedFiles: () => void;
  closeChangedFiles: () => void;
  toggleReview: () => void;
  closeReview: () => void;
  toggleWorktrees: () => void;
  closeWorktrees: () => void;
  toggleRemote: () => void;
  closeRemote: () => void;
  togglePreview: () => void;
  openPreview: () => void;
  closePreview: () => void;
  toggleComputer: () => void;
  closeComputer: () => void;
  setWorkbenchTab: (tab: WorkbenchTab) => void;
  setEditorDirty: (dirty: boolean) => void;
  setInputContent: (content: string) => void;
  setEditorWidthPct: (pct: number) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  sidebarOpen: true,
  settingsOpen: false,
  modelSelectorOpen: false,
  terminalOpen: false,
  changedFilesOpen: false,
  reviewOpen: false,
  worktreesOpen: false,
  remoteOpen: false,
  previewOpen: false,
  computerOpen: false,
  workbenchTab: 'code',
  editorDirty: false,
  inputContent: '',
  editorWidthPct: loadEditorWidth(),
  fileTreeOpen: loadFileTreeOpen(),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleFileTree: () => set((s) => {
    const next = !s.fileTreeOpen;
    try { localStorage.setItem(FILE_TREE_OPEN_KEY, next ? '1' : '0'); } catch {}
    return { fileTreeOpen: next };
  }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  toggleModelSelector: () => set((s) => ({ modelSelectorOpen: !s.modelSelectorOpen })),
  closeModelSelector: () => set({ modelSelectorOpen: false }),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  toggleChangedFiles: () => set((s) => ({ changedFilesOpen: !s.changedFilesOpen })),
  closeChangedFiles: () => set({ changedFilesOpen: false }),
  toggleReview: () => set((s) => ({ reviewOpen: !s.reviewOpen })),
  closeReview: () => set({ reviewOpen: false }),
  toggleWorktrees: () => set((s) => ({ worktreesOpen: !s.worktreesOpen })),
  closeWorktrees: () => set({ worktreesOpen: false }),
  toggleRemote: () => set((s) => ({ remoteOpen: !s.remoteOpen })),
  closeRemote: () => set({ remoteOpen: false }),
  // Opening the preview always brings it to the front of the workbench;
  // closing it falls back to the code tab (which may itself be empty).
  togglePreview: () => set((s) => (s.previewOpen
    ? { previewOpen: false, workbenchTab: 'code' as WorkbenchTab }
    : { previewOpen: true, workbenchTab: 'preview' as WorkbenchTab })),
  openPreview: () => set({ previewOpen: true, workbenchTab: 'preview' }),
  closePreview: () => set({ previewOpen: false, workbenchTab: 'code' }),
  toggleComputer: () => set((s) => ({ computerOpen: !s.computerOpen })),
  closeComputer: () => set({ computerOpen: false }),
  setWorkbenchTab: (tab) => set({ workbenchTab: tab }),
  setEditorDirty: (dirty) => set({ editorDirty: dirty }),
  setInputContent: (content) => set({ inputContent: content }),
  setEditorWidthPct: (pct) => {
    const clamped = clampEditorWidth(pct);
    try { localStorage.setItem(EDITOR_WIDTH_KEY, String(clamped)); } catch {}
    set({ editorWidthPct: clamped });
  },
}));
