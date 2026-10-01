import { create } from 'zustand';
import type { SlashCommand } from '../core/commands';
import {
  memoryFileCandidates, selectExistingFiles, type MemoryFile,
} from '../core/memory/memoryFiles';
import { canAddRoot, normalizeRoot, rootOf, displayPath, type AddRootResult } from '../core/workspace/roots';

// The home directory only changes when the machine does, so it is fetched once
// and reused rather than crossing IPC on every folder open.
let cachedHomeDir: string | null = null;
async function getHomeDir(): Promise<string> {
  if (cachedHomeDir) return cachedHomeDir;
  const info = await window.electronAPI.app.getSystemInfo().catch(() => null);
  const home = (info as any)?.homedir || '';
  cachedHomeDir = home;
  return home;
}

/**
 * A folder open beside the primary one. It carries its own tree; the primary
 * root's tree stays in `files` so everything already reading that keeps working.
 */
export interface ExtraRoot {
  path: string;
  files: FileItem[];
}

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileItem[];
  expanded?: boolean;
}

interface ContextFile {
  path: string;
  content: string;
  isImage?: boolean;
  dataUrl?: string;
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.includes(ext);
}

interface ProjectConfig {
  // Contents of the project memory file (AGENTS.md / CLAUDE.md), injected into
  // the system prompt by buildSystemMessages so the agent always sees the
  // project's house rules. Codex uses AGENTS.md; Claude Code uses CLAUDE.md —
  // we support both (first found wins).
  agentsMd: string | null;
  agentsMdPath: string | null;
  /** Every memory file in effect for this workspace, furthest-first. */
  memoryFiles: MemoryFile[];
  // Custom slash commands from <root>/.conecode/commands/*.md.
  customCommands: SlashCommand[];
}

interface WorkspaceStore extends ProjectConfig {
  rootPath: string | null;
  files: FileItem[];
  /** Folders opened alongside the primary one, each with its own tree. */
  extraRoots: ExtraRoot[];
  selectedFile: string | null;
  fileContent: string | null;
  selectedFileIsImage: boolean;
  /** VS Code-style open editors. selectedFile is always the active tab. */
  openTabs: string[];
  /** Unsaved-edit markers per tab (not persisted in snapshots). */
  dirtyTabs: Record<string, boolean>;
  setTabDirty: (filePath: string, dirty: boolean) => void;
  contextFiles: ContextFile[];
  // Flat, relative file list of the workspace, lazily built for @-mention
  // autocomplete. Null until first requested / rebuilt after a refresh.
  fileList: string[] | null;
  // Tools exposed by connected MCP servers (for the system prompt + UI).
  mcpTools: { server: string; name: string; description?: string; inputSchema?: any }[];
  openFolder: () => Promise<void>;
  // Open a known folder path directly (no dialog) — used to restore an old
  // conversation's persisted folder. Returns false if the path is gone.
  openFolderPath: (folderPath: string) => Promise<boolean>;
  readDir: (dirPath: string) => Promise<FileItem[]>;
  toggleExpand: (dirPath: string) => void;
  collapseAll: () => void;
  selectFile: (filePath: string) => Promise<void>;
  closeFile: () => void;
  /** Close one editor tab; the active tab falls back to a neighbour. */
  closeTab: (filePath: string) => Promise<void>;
  closeOtherTabs: (filePath: string) => Promise<void>;
  closeAllTabs: () => void;
  /** IDE file operations — each refreshes only the affected tree branch. */
  createFile: (parentDir: string, name: string) => Promise<string | null>;
  createFolder: (parentDir: string, name: string) => Promise<string | null>;
  renamePath: (oldPath: string, newName: string) => Promise<string | null>;
  deletePath: (targetPath: string, isDirectory: boolean) => Promise<boolean>;
  resetWorkspace: () => void;
  saveFile: (content: string) => Promise<void>;
  refreshFiles: () => Promise<void>;
  refreshDir: (dirPath: string) => Promise<void>;
  addContextFile: (filePath: string) => Promise<void>;
  addPastedImage: (dataUrl: string, name?: string) => void;
  removeContextFile: (filePath: string) => void;
  clearContextFiles: () => void;
  reloadProjectConfig: () => Promise<void>;
  /** Every open folder, primary first. */
  allRoots: () => string[];
  addRoot: (folderPath: string) => Promise<AddRootResult>;
  addRootFromDialog: () => Promise<AddRootResult>;
  removeRoot: (folderPath: string) => void;
  ensureFileList: () => Promise<string[]>;
  saveSnapshot: () => { rootPath: string | null; files: FileItem[]; extraRoots: ExtraRoot[]; selectedFile: string | null; openTabs: string[]; fileContent: string | null; selectedFileIsImage: boolean; contextFiles: ContextFile[] } & ProjectConfig;
  restoreSnapshot: (snapshot: { rootPath: string | null; files: FileItem[]; extraRoots?: ExtraRoot[]; selectedFile: string | null; openTabs?: string[]; fileContent: string | null; selectedFileIsImage?: boolean; contextFiles: ContextFile[] } & Partial<ProjectConfig>) => void;
}

async function loadDir(dirPath: string): Promise<FileItem[]> {
  const items = await window.electronAPI.fs.readDir(dirPath);
  return items.map((item: any) => ({
    ...item,
    expanded: false,
    children: item.isDirectory ? [] : undefined,
  }));
}

/** File name validation shared by create/rename (VS Code rejects these too). */
export function isValidFileName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return false;
  if (trimmed.length > 255) return false;
  return !/[<>:"|?*\0]/.test(trimmed) && !trimmed.endsWith('.');
}

function setExpandedRecursive(items: FileItem[], expanded: boolean): FileItem[] {
  return items.map((item) => ({
    ...item,
    expanded: item.isDirectory ? expanded : undefined,
    children: item.children ? setExpandedRecursive(item.children, expanded) : item.children,
  }));
}

/** Remove a path (and, for dirs, everything under it) from a tree. */
export function removePathFromTree(items: FileItem[], targetPath: string): FileItem[] {
  const out: FileItem[] = [];
  for (const item of items) {
    if (item.path === targetPath) continue;
    if (item.children?.length) {
      out.push({ ...item, children: removePathFromTree(item.children, targetPath) });
    } else {
      out.push(item);
    }
  }
  return out;
}

// First line of a custom-command markdown file, used as its palette description.
// A leading "# Title" or "> desc" line is unwrapped; otherwise the raw first
// non-empty line is used (trimmed).
function firstLineDescription(body: string): string {
  const line = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || 'Custom command';
  return line.replace(/^#+\s*/, '').replace(/^>\s*/, '').slice(0, 80);
}

// Load project-level config from the workspace: the AGENTS.md/CLAUDE.md memory
// file and any custom slash commands under .conecode/commands/. Tolerant of
// missing files/dirs (readFile → null, readDir → []).
async function loadProjectConfig(rootPath: string): Promise<ProjectConfig> {
  // Memory files, the way Claude Code layers them: the user's own file, then
  // any ancestor directory's (so a monorepo root reaches its packages), then
  // the project's. Nearest last — see core/memory/memoryFiles.ts.
  const homeDir = await getHomeDir();
  const candidates = memoryFileCandidates({ homeDir, rootPath });
  const read = await Promise.all(candidates.map(async (file) => ({
    ...file,
    content: await window.electronAPI.fs.readFile(file.path),
  })));
  const memoryFiles = selectExistingFiles(read);

  // The project's own file is what /agents opens and what a new memory is
  // written to, so it stays called out separately.
  const projectFile = memoryFiles.find((f) => f.scope === 'project');
  const agentsMd = projectFile?.content ?? null;
  const agentsMdPath = projectFile?.path ?? null;

  const customCommands: SlashCommand[] = [];
  const items = await window.electronAPI.fs.readDir(`${rootPath}/.conecode/commands`);
  for (const it of items) {
    if (it.isDirectory || !it.name.endsWith('.md')) continue;
    const body = await window.electronAPI.fs.readFile(it.path);
    if (body == null) continue;
    customCommands.push({
      name: it.name.replace(/\.md$/, ''),
      description: firstLineDescription(body),
      kind: 'prompt',
      template: body,
      custom: true,
    });
  }
  return { agentsMd, agentsMdPath, memoryFiles, customCommands };
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  rootPath: null,
  files: [],
  extraRoots: [],
  selectedFile: null,
  fileContent: null,
  selectedFileIsImage: false,
  openTabs: [],
  dirtyTabs: {},
  contextFiles: [],
  agentsMd: null,
  agentsMdPath: null,
  memoryFiles: [],
  customCommands: [],
  fileList: null,
  mcpTools: [],

  openFolder: async () => {
    const folderPath = await window.electronAPI.dialog.openFolder();
    if (!folderPath) return;
    await get().openFolderPath(folderPath);
    // Bind the folder to the active conversation (persisted), so this chat's
    // folder comes back when the user returns to it — even after a restart.
    // Dynamic import: chat.store imports this store statically.
    const { useChatStore } = await import('./chat.store');
    await useChatStore.getState().setConversationFolder(folderPath);
  },

  openFolderPath: async (folderPath: string) => {
    const stat = await window.electronAPI.fs.stat(folderPath);
    if (!stat?.isDirectory) return false;
    const files = await loadDir(folderPath);
    set({ rootPath: folderPath, files, extraRoots: [], selectedFile: null, openTabs: [], dirtyTabs: {}, fileContent: null, selectedFileIsImage: false, fileList: null });
    // Load AGENTS.md + custom commands in the background; don't block the open.
    const cfg = await loadProjectConfig(folderPath);
    set(cfg);
    // Reconnect MCP servers (incl. this workspace's .conecode/mcp.json) and pick
    // up their tools. May spawn external processes — fire-and-forget.
    (window as any).electronAPI?.mcp?.reload?.(folderPath)
      .then((tools: any[]) => set({ mcpTools: tools || [] }))
      .catch(() => {});
    return true;
  },

  readDir: async (dirPath: string) => {
    return loadDir(dirPath);
  },

  toggleExpand: async (dirPath: string) => {
    const { files } = get();

    const updateFiles = async (items: FileItem[]): Promise<FileItem[]> => {
      const result: FileItem[] = [];
      for (const item of items) {
        if (item.path === dirPath && item.isDirectory) {
          const newExpanded = !item.expanded;
          const children = newExpanded && item.children?.length === 0
            ? await loadDir(dirPath)
            : item.children || [];
          result.push({ ...item, expanded: newExpanded, children });
        } else if (item.children && item.children.length > 0) {
          result.push({ ...item, children: await updateFiles(item.children) });
        } else {
          result.push(item);
        }
      }
      return result;
    };

    // The path may belong to the primary tree or to any extra root's, so
    // rebuild whichever one owns it and leave the others untouched.
    const { extraRoots } = get();
    const owner = extraRoots.find((r) => dirPath === r.path || dirPath.startsWith(r.path + '/'));
    if (owner) {
      const updated = await updateFiles(owner.files);
      set({ extraRoots: extraRoots.map((r) => (r.path === owner.path ? { ...r, files: updated } : r)) });
      return;
    }
    set({ files: await updateFiles(files) });
  },

  collapseAll: () => {
    set((s) => ({
      files: setExpandedRecursive(s.files, false),
      extraRoots: s.extraRoots.map((r) => ({ ...r, files: setExpandedRecursive(r.files, false) })),
    }));
  },

  setTabDirty: (filePath, dirty) => {
    set((s) => {
      if (!!s.dirtyTabs[filePath] === dirty) return {} as any;
      const dirtyTabs = { ...s.dirtyTabs };
      if (dirty) dirtyTabs[filePath] = true;
      else delete dirtyTabs[filePath];
      return { dirtyTabs };
    });
  },

  selectFile: async (filePath: string) => {
    // Images: load as a base64 data URL so the editor can render them instead
    // of dumping raw bytes as garbled text into the textarea.
    if (isImageFile(filePath)) {
      const dataUrl = await window.electronAPI.fs.readFileBase64(filePath);
      set((s) => ({
        selectedFile: filePath,
        fileContent: dataUrl,
        selectedFileIsImage: true,
        openTabs: s.openTabs.includes(filePath) ? s.openTabs : [...s.openTabs, filePath],
      }));
      return;
    }
    const content = await window.electronAPI.fs.readFile(filePath);
    set((s) => ({
      selectedFile: filePath,
      fileContent: content,
      selectedFileIsImage: false,
      openTabs: s.openTabs.includes(filePath) ? s.openTabs : [...s.openTabs, filePath],
    }));
  },

  closeFile: () => {
    const { selectedFile } = get();
    if (selectedFile) {
      void get().closeTab(selectedFile);
      return;
    }
    set({ selectedFile: null, fileContent: null, selectedFileIsImage: false });
  },

  closeTab: async (filePath: string) => {
    const { openTabs, selectedFile } = get();
    if (!openTabs.includes(filePath)) {
      if (selectedFile === filePath) {
        set({ selectedFile: null, fileContent: null, selectedFileIsImage: false });
      }
      return;
    }
    const remaining = openTabs.filter((p) => p !== filePath);
    if (selectedFile !== filePath) {
      set((s) => {
        const dirtyTabs = { ...s.dirtyTabs };
        delete dirtyTabs[filePath];
        return { openTabs: remaining, dirtyTabs };
      });
      return;
    }
    // The active tab is closing — fall back to a neighbour (right, else left).
    const idx = openTabs.indexOf(filePath);
    const next = remaining[Math.min(idx, remaining.length - 1)] ?? null;
    if (!next) {
      set((s) => {
        const dirtyTabs = { ...s.dirtyTabs };
        delete dirtyTabs[filePath];
        return { openTabs: remaining, dirtyTabs, selectedFile: null, fileContent: null, selectedFileIsImage: false };
      });
      return;
    }
    set((s) => {
      const dirtyTabs = { ...s.dirtyTabs };
      delete dirtyTabs[filePath];
      return { openTabs: remaining, dirtyTabs };
    });
    await get().selectFile(next);
  },

  closeOtherTabs: async (filePath: string) => {
    const { openTabs } = get();
    if (!openTabs.includes(filePath)) return;
    set((s) => {
      const dirtyTabs: Record<string, boolean> = {};
      if (s.dirtyTabs[filePath]) dirtyTabs[filePath] = true;
      return { openTabs: [filePath], dirtyTabs };
    });
    await get().selectFile(filePath);
  },

  closeAllTabs: () => {
    set({ openTabs: [], dirtyTabs: {}, selectedFile: null, fileContent: null, selectedFileIsImage: false });
  },

  createFile: async (parentDir: string, name: string) => {
    const clean = name.trim().replace(/[/\\]+/g, '');
    if (!isValidFileName(clean)) return null;
    const full = `${parentDir}/${clean}`;
    const ok = await window.electronAPI.fs.writeFile(full, '');
    if (!ok) return null;
    await get().refreshDir(parentDir);
    await get().selectFile(full);
    return full;
  },

  createFolder: async (parentDir: string, name: string) => {
    const clean = name.trim().replace(/[/\\]+/g, '');
    if (!isValidFileName(clean)) return null;
    const full = `${parentDir}/${clean}`;
    const ok = await window.electronAPI.fs.createDir(full);
    if (!ok) return null;
    await get().refreshDir(parentDir);
    return full;
  },

  renamePath: async (oldPath: string, newName: string) => {
    const clean = newName.trim().replace(/[/\\]+/g, '');
    if (!isValidFileName(clean)) return null;
    const dir = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
    const newPath = dir ? `${dir}/${clean}` : clean;
    if (newPath === oldPath) return oldPath;
    const ok = await window.electronAPI.fs.rename(oldPath, newPath);
    if (!ok) return null;
    // Retarget any open tabs at or under the renamed path.
    const { openTabs, selectedFile } = get();
    const retarget = (p: string) => (p === oldPath || p.startsWith(oldPath + '/') ? newPath + p.slice(oldPath.length) : p);
    const tabs = openTabs.map(retarget);
    set({ openTabs: tabs, fileList: null });
    if (selectedFile && (selectedFile === oldPath || selectedFile.startsWith(oldPath + '/'))) {
      await get().selectFile(retarget(selectedFile));
    }
    await get().refreshFiles();
    return newPath;
  },

  deletePath: async (targetPath: string, isDirectory: boolean) => {
    const ok = isDirectory
      ? await window.electronAPI.fs.deleteDir(targetPath)
      : await window.electronAPI.fs.deleteFile(targetPath);
    if (!ok) return false;
    // Close any tabs at or under the deleted path.
    const { openTabs, selectedFile } = get();
    const doomed = openTabs.filter((p) => p === targetPath || p.startsWith(targetPath + '/'));
    const remaining = openTabs.filter((p) => !(p === targetPath || p.startsWith(targetPath + '/')));
    set((s) => {
      const dirtyTabs = { ...s.dirtyTabs };
      for (const p of doomed) delete dirtyTabs[p];
      return { dirtyTabs };
    });
    try {
      const { useAiHighlightsStore } = await import('./aiHighlights.store');
      for (const p of doomed) useAiHighlightsStore.getState().clearFile(p);
    } catch {}
    if (selectedFile && (selectedFile === targetPath || selectedFile.startsWith(targetPath + '/'))) {
      const idx = Math.max(0, openTabs.indexOf(selectedFile) - doomed.length);
      const next = remaining[Math.min(idx, remaining.length - 1)] ?? null;
      set({ openTabs: remaining });
      if (next) await get().selectFile(next);
      else set({ selectedFile: null, fileContent: null, selectedFileIsImage: false });
    } else {
      set({ openTabs: remaining });
    }
    set((s) => ({
      files: removePathFromTree(s.files, targetPath),
      extraRoots: s.extraRoots.map((r) => ({ ...r, files: removePathFromTree(r.files, targetPath) })),
      fileList: null,
    }));
    return true;
  },

  resetWorkspace: () => {
    set({ rootPath: null, files: [], extraRoots: [], selectedFile: null, openTabs: [], dirtyTabs: {}, fileContent: null, selectedFileIsImage: false, contextFiles: [], agentsMd: null, agentsMdPath: null, memoryFiles: [], customCommands: [], fileList: null, mcpTools: [] });
  },

  // Re-read AGENTS.md and custom commands from disk — call after the agent
  // creates/edits those files (e.g. /init writes AGENTS.md) so the freshly
  // written memory is picked up into the next system prompt without reopening.
  reloadProjectConfig: async () => {
    const { rootPath } = get();
    if (!rootPath) return;
    set(await loadProjectConfig(rootPath));
  },

  allRoots: () => {
    const { rootPath, extraRoots } = get();
    return [rootPath, ...extraRoots.map((r) => r.path)].filter((p): p is string => !!p);
  },

  // Open another folder beside the current one. Nesting is refused rather than
  // silently producing a tree that shows the same file twice — see
  // core/workspace/roots.ts for why.
  addRoot: async (folderPath: string) => {
    const path = normalizeRoot(folderPath);
    const verdict = canAddRoot(path, get().allRoots());
    if (!verdict.ok) return verdict;

    const stat = await window.electronAPI.fs.stat(path);
    if (!stat?.isDirectory) return { ok: false, reason: 'empty' as const };

    // With nothing open yet, the first folder becomes the primary one.
    if (!get().rootPath) {
      await get().openFolderPath(path);
      return verdict;
    }

    const files = await loadDir(path);
    set((state) => ({ extraRoots: [...state.extraRoots, { path, files }], fileList: null }));
    return verdict;
  },

  addRootFromDialog: async () => {
    const folderPath = await window.electronAPI.dialog.openFolder();
    if (!folderPath) return { ok: false, reason: 'empty' as const };
    return get().addRoot(folderPath);
  },

  removeRoot: (folderPath: string) => {
    const path = normalizeRoot(folderPath);
    // Closing a folder must not leave a file from it open in the editor.
    const state = get();
    const remaining = state.openTabs.filter((p) => rootOf(p, [path]) === null);
    const closesOpenFile = state.selectedFile ? rootOf(state.selectedFile, [path]) !== null : false;
    const dirtyTabs = Object.fromEntries(
      Object.entries(state.dirtyTabs).filter(([p]) => rootOf(p, [path]) === null),
    );
    set({
      extraRoots: state.extraRoots.filter((r) => r.path !== path),
      fileList: null,
      openTabs: remaining,
      dirtyTabs,
      ...(closesOpenFile ? { selectedFile: null, fileContent: null, selectedFileIsImage: false } : {}),
    });
    if (closesOpenFile && remaining.length) {
      void get().selectFile(remaining[remaining.length - 1]);
    }
  },

  // Lazily build (and cache) a flat list of workspace-relative file paths for
  // @-mention autocomplete. Reuses the main-process glob (which already ignores
  // node_modules/.git/dist/…). Rebuilt by refreshFiles.
  ensureFileList: async () => {
    const cached = get().fileList;
    if (cached) return cached;
    const roots = get().allRoots();
    if (!roots.length) return [];

    // One glob per open folder. Each result is labelled by displayPath, so a
    // file from a second folder completes as "api/src/main.ts" rather than a
    // bare "src/main.ts" that could mean either of two files.
    const budget = Math.max(500, Math.floor(5000 / roots.length));
    const perRoot = await Promise.all(roots.map((root) =>
      window.electronAPI.fs.glob({ pattern: '**/*', dir: root, maxResults: budget }),
    ));
    const rel = perRoot.flat().map((p) => displayPath(p, roots));
    set({ fileList: rel });
    return rel;
  },

  saveSnapshot: () => {
    const { rootPath, files, extraRoots, selectedFile, openTabs, fileContent, selectedFileIsImage, contextFiles, agentsMd, agentsMdPath, memoryFiles, customCommands } = get();
    return { rootPath, files, extraRoots, selectedFile, openTabs, fileContent, selectedFileIsImage, contextFiles, agentsMd, agentsMdPath, memoryFiles, customCommands };
  },

  restoreSnapshot: (snapshot) => {
    set({ fileList: null, extraRoots: [], openTabs: [], agentsMd: null, agentsMdPath: null, memoryFiles: [], customCommands: [], ...snapshot });
  },

  addContextFile: async (filePath: string) => {
    const { contextFiles } = get();
    if (contextFiles.some(f => f.path === filePath)) return;
    if (isImageFile(filePath)) {
      const dataUrl = await window.electronAPI.fs.readFileBase64(filePath);
      if (!dataUrl) return;
      set({ contextFiles: [...contextFiles, { path: filePath, content: '', isImage: true, dataUrl }] });
      return;
    }
    const content = await window.electronAPI.fs.readFile(filePath);
    if (content == null) return;
    set({ contextFiles: [...contextFiles, { path: filePath, content }] });
  },

  // Attach an image pasted straight into the chat input. There's no file on
  // disk, so we key it by a synthetic, always-unique path and carry the base64
  // data URL — identical in shape to an attached image file, so it flows through
  // the vision message builder unchanged.
  addPastedImage: (dataUrl: string, name?: string) => {
    const { contextFiles } = get();
    const ext = (dataUrl.match(/^data:image\/([a-z0-9.+-]+)/i)?.[1] || 'png').replace('+xml', '');
    const path = name && !contextFiles.some(f => f.path === name)
      ? name
      : `pasted-image-${Date.now()}.${ext}`;
    set({ contextFiles: [...contextFiles, { path, content: '', isImage: true, dataUrl }] });
  },

  removeContextFile: (filePath: string) => {
    const { contextFiles } = get();
    set({ contextFiles: contextFiles.filter(f => f.path !== filePath) });
  },

  clearContextFiles: () => {
    set({ contextFiles: [] });
  },

  saveFile: async (content: string) => {
    const { selectedFile } = get();
    if (!selectedFile) return;
    await window.electronAPI.fs.writeFile(selectedFile, content);
    set({ fileContent: content });
  },

  refreshFiles: async () => {
    const { rootPath, extraRoots } = get();
    if (!rootPath) return;
    const files = await loadDir(rootPath);
    // Preserve expansion across a full refresh so create/rename/delete don't
    // collapse the tree the user is looking at.
    const collect = (items: FileItem[]): [string, boolean][] =>
      items.flatMap((i) => [[i.path, !!i.expanded] as [string, boolean], ...(i.children ? collect(i.children) : [])]);
    const prev = new Map<string, boolean>(collect(get().files));
    const restore = (items: FileItem[]): FileItem[] => items.map((i) => ({
      ...i,
      expanded: prev.get(i.path) ?? false,
      children: i.children ? restore(i.children) : i.children,
    }));
    void extraRoots;
    set({ files: restore(files), fileList: null });
  },

  refreshDir: async (dirPath: string) => {
    const { rootPath, extraRoots, files } = get();
    if (!rootPath) return;
    // The tree only stores children for expanded dirs; a create inside a
    // collapsed dir just needs an expansion to reveal it.
    const owner = extraRoots.find((r) => dirPath === r.path || dirPath.startsWith(r.path + '/'));
    const fresh = await loadDir(dirPath).catch(() => null);
    if (!fresh) return;
    // Merge: keep the expanded state of subdirectories that still exist.
    const prevExpanded = new Map<string, FileItem>();
    const collect = (items: FileItem[]) => {
      for (const i of items) {
        if (i.isDirectory) {
          prevExpanded.set(i.path, i);
          if (i.children) collect(i.children);
        }
      }
    };
    collect(owner ? owner.files : files);
    const merged = fresh.map((item) => {
      const prev = prevExpanded.get(item.path);
      if (prev && item.isDirectory) {
        return { ...item, expanded: !!prev.expanded, children: prev.children ?? item.children };
      }
      return item;
    });
    const graft = (items: FileItem[]): FileItem[] => items.map((item) => {
      if (item.path === dirPath && item.isDirectory) {
        return { ...item, expanded: true, children: merged };
      }
      if (item.children) return { ...item, children: graft(item.children) };
      return item;
    });
    if (owner) {
      if (dirPath === owner.path) {
        set({ extraRoots: extraRoots.map((r) => (r.path === owner.path ? { ...r, files: merged.map((m) => ({ ...m, expanded: prevExpanded.get(m.path)?.expanded ?? false })) } : r)), fileList: null });
      } else {
        set({ extraRoots: extraRoots.map((r) => (r.path === owner.path ? { ...r, files: graft(r.files) } : r)), fileList: null });
      }
      return;
    }
    if (dirPath === rootPath) {
      set({ files: merged.map((m) => ({ ...m, expanded: prevExpanded.get(m.path)?.expanded ?? m.expanded })), fileList: null });
      return;
    }
    set({ files: graft(files), fileList: null });
  },
}));
