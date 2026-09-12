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
  selectFile: (filePath: string) => Promise<void>;
  closeFile: () => void;
  resetWorkspace: () => void;
  saveFile: (content: string) => Promise<void>;
  refreshFiles: () => Promise<void>;
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
  saveSnapshot: () => { rootPath: string | null; files: FileItem[]; selectedFile: string | null; fileContent: string | null; selectedFileIsImage: boolean; contextFiles: ContextFile[] } & ProjectConfig;
  restoreSnapshot: (snapshot: { rootPath: string | null; files: FileItem[]; selectedFile: string | null; fileContent: string | null; selectedFileIsImage?: boolean; contextFiles: ContextFile[] } & Partial<ProjectConfig>) => void;
}

async function loadDir(dirPath: string): Promise<FileItem[]> {
  const items = await window.electronAPI.fs.readDir(dirPath);
  return items.map((item: any) => ({
    ...item,
    expanded: false,
    children: item.isDirectory ? [] : undefined,
  }));
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
    set({ rootPath: folderPath, files, extraRoots: [], selectedFile: null, fileContent: null, selectedFileIsImage: false, fileList: null });
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

  selectFile: async (filePath: string) => {
    // Images: load as a base64 data URL so the editor can render them instead
    // of dumping raw bytes as garbled text into the textarea.
    if (isImageFile(filePath)) {
      const dataUrl = await window.electronAPI.fs.readFileBase64(filePath);
      set({ selectedFile: filePath, fileContent: dataUrl, selectedFileIsImage: true });
      return;
    }
    const content = await window.electronAPI.fs.readFile(filePath);
    set({ selectedFile: filePath, fileContent: content, selectedFileIsImage: false });
  },

  closeFile: () => {
    set({ selectedFile: null, fileContent: null, selectedFileIsImage: false });
  },

  resetWorkspace: () => {
    set({ rootPath: null, files: [], extraRoots: [], selectedFile: null, fileContent: null, selectedFileIsImage: false, contextFiles: [], agentsMd: null, agentsMdPath: null, memoryFiles: [], customCommands: [], fileList: null, mcpTools: [] });
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
    const closesOpenFile = state.selectedFile ? rootOf(state.selectedFile, [path]) !== null : false;
    set({
      extraRoots: state.extraRoots.filter((r) => r.path !== path),
      fileList: null,
      ...(closesOpenFile ? { selectedFile: null, fileContent: null, selectedFileIsImage: false } : {}),
    });
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
    const { rootPath, files, extraRoots, selectedFile, fileContent, selectedFileIsImage, contextFiles, agentsMd, agentsMdPath, memoryFiles, customCommands } = get();
    return { rootPath, files, extraRoots, selectedFile, fileContent, selectedFileIsImage, contextFiles, agentsMd, agentsMdPath, memoryFiles, customCommands };
  },

  restoreSnapshot: (snapshot) => {
    set({ fileList: null, extraRoots: [], agentsMd: null, agentsMdPath: null, memoryFiles: [], customCommands: [], ...snapshot });
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
    const { rootPath } = get();
    if (!rootPath) return;
    const files = await loadDir(rootPath);
    set({ files, fileList: null });
  },
}));
