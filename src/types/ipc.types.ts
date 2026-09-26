import type { AIModel } from './model.types';
import type { Conversation, Message } from './chat.types';
import type { ProviderConfig } from './provider.types';
// The preview's shapes are defined next to its logic and shared with main.
import type { PreviewPlan, PreviewStatus, PreviewLog } from '../core/preview/preview';
import type { ComputerRequest, DisplayGeometry } from '../core/computer/computer';

export type { PreviewPlan, PreviewStatus, PreviewLog };
export type { ComputerRequest, DisplayGeometry };

export interface ComputerStatus {
  platform: string;
  enabled: boolean;
  supported: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  geometry: DisplayGeometry | null;
}

export interface ComputerActionResult {
  ok: boolean;
  message: string;
  cursor?: [number, number];
  needsPermission?: 'accessibility' | 'screenRecording';
}

export type ComputerScreenshot =
  | { dataUrl: string; geometry: DisplayGeometry }
  | { error: string; needsPermission?: 'screenRecording' };

export interface IPCChannels {
  'provider:list': { result: any[] };
  'provider:create': { config: any; result: any };
  'provider:update': { id: string; config: any; result: any };
  'provider:delete': { id: string; result: boolean };
  'secure:set': { key: string; value: string; result: boolean };
  'secure:get': { key: string; result: string | null };
  'secure:delete': { key: string; result: boolean };
  'conversation:list': { result: any[] };
  'conversation:create': { data: any; result: any };
  'conversation:delete': { id: string; result: boolean };
  'message:list': { conversationId: string; result: any[] };
  'message:create': { data: any; result: any };
  'model:list': { providerId?: string; result: any[] };
  'model:upsert': { models: any[]; result: boolean };
  'settings:get': { result: any };
  'settings:update': { data: any; result: any };
  'favorite:list': { result: string[] };
  'favorite:toggle': { modelId: string; result: string[] };
  'recent:list': { result: string[] };
  'recent:add': { modelId: string; result: string[] };
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FileStat {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  createdAt: string;
  modifiedAt: string;
}

export interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Whether the command actually ran confined (false on non-macOS or when off). */
  sandboxed?: boolean;
}

export interface SandboxRequest {
  mode: 'off' | 'workspaceWrite';
  allowNetwork?: boolean;
  extraWritableRoots?: string[];
  /** Required for hdiutil to create, attach, or detach a disk image on macOS. */
  allowDiskImages?: boolean;
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

export interface McpToolSummary {
  server: string;
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface GitWorktree {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
  managed: boolean;
  dirty: number;
}

export interface ChatStreamParams {
  providerId: string;
  modelId: string;
  messages: any[];
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
  /** Background calls are independent from the user-stoppable main stream. */
  silent?: boolean;
  /** Keep an owned main request stoppable without forwarding its chunks to the transcript. */
  emitChunks?: boolean;
  /** Native function-calling tool schemas; omitted in prompt mode. */
  tools?: { name: string; description: string; parameters: any }[];
  toolChoice?: 'auto' | 'none' | 'required';
  /**
   * Conversation that owns this stream. Tags every forwarded chunk so
   * concurrent conversations stream into their own buffers, and keys the
   * main-process abort controller so starting another chat never cancels a
   * running one.
   */
  conversationId?: string;
}

/**
 * The preload bridge (see electron/preload.ts). Declared here so the renderer is
 * type-checked against the API it actually has — without it every `window.electronAPI`
 * call site is an error the build silently tolerated.
 */
export interface ElectronAPI {
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
  };
  notification: {
    show: (options: {
      title: string;
      body: string;
      mode: 'never' | 'background' | 'always';
    }) => Promise<boolean>;
  };
  power: {
    setPreventSleep: (on: boolean) => Promise<boolean>;
  };
  provider: {
    list: () => Promise<ProviderConfig[]>;
    create: (config: any) => Promise<ProviderConfig>;
    update: (id: string, config: any) => Promise<ProviderConfig | null>;
    delete: (id: string) => Promise<boolean>;
  };
  model: {
    list: (providerId?: string) => Promise<AIModel[]>;
    probe: (config: any) => Promise<{ ok: boolean; models?: AIModel[]; error?: string }>;
  };
  conversation: {
    list: () => Promise<Conversation[]>;
    create: (data: any) => Promise<Conversation>;
    update: (id: string, data: any) => Promise<void>;
    delete: (id: string) => Promise<boolean>;
  };
  message: {
    list: (conversationId: string) => Promise<Message[]>;
    create: (data: any) => Promise<Message>;
    delete: (messageId: string) => Promise<boolean>;
    editAndTruncate: (conversationId: string, messageId: string, content: string) => Promise<Message>;
  };
  settings: {
    get: () => Promise<any>;
    update: (data: any) => Promise<any>;
  };
  favorite: {
    list: () => Promise<string[]>;
    toggle: (modelId: string) => Promise<string[]>;
  };
  recent: {
    list: () => Promise<string[]>;
    add: (modelId: string) => Promise<string[]>;
  };
  chat: {
    stream: (params: ChatStreamParams) => Promise<any>;
    stop?: (conversationId?: string) => Promise<boolean>;
    onChunk: (callback: (chunk: any) => void) => () => void;
  };
  dialog: {
    openFolder: () => Promise<string | null>;
    openFile: () => Promise<string[]>;
    saveFile: (defaultPath?: string) => Promise<string | null>;
  };
  fs: {
    readFile: (filePath: string) => Promise<string | null>;
    readFileBase64: (filePath: string) => Promise<string | null>;
    writeFile: (filePath: string, content: string) => Promise<boolean>;
    writeFileBase64: (filePath: string, base64: string) => Promise<boolean>;
    readDir: (dirPath: string) => Promise<DirEntry[]>;
    exists: (filePath: string) => Promise<boolean>;
    createDir: (dirPath: string) => Promise<boolean>;
    deleteFile: (filePath: string) => Promise<boolean>;
    deleteDir: (dirPath: string) => Promise<boolean>;
    rename: (oldPath: string, newPath: string) => Promise<boolean>;
    move: (srcPath: string, destPath: string) => Promise<boolean>;
    copy: (srcPath: string, destPath: string) => Promise<boolean>;
    stat: (filePath: string) => Promise<FileStat | null>;
    search: (opts: { query: string; dir?: string; isRegex?: boolean; maxResults?: number }) => Promise<SearchMatch[]>;
    glob: (opts: { pattern: string; dir?: string; maxResults?: number }) => Promise<string[]>;
  };
  exec: {
    run: (command: string, cwd?: string, sandbox?: SandboxRequest) => Promise<ExecResult>;
    spawn: (command: string, args: string[], cwd?: string) => Promise<ExecResult>;
  };
  app: {
    open: (appName: string) => Promise<boolean>;
    openPath: (path: string) => Promise<boolean>;
    getSystemInfo: () => Promise<Record<string, any>>;
  };
  git: {
    info: (cwd?: string) => Promise<{ isRepo: boolean; branch: string | null; dirty: number }>;
    status: (cwd?: string) => Promise<string>;
    diff: (cwd?: string, file?: string) => Promise<string>;
    branches: (cwd?: string) => Promise<string[]>;
    review: (cwd: string, options: {
      scope: 'uncommitted' | 'base' | 'commit';
      target?: string;
    }) => Promise<{ ok: boolean; status?: string; diff?: string; error?: string; scope?: string; target?: string | null }>;
  };
  worktree: {
    list: (cwd: string) => Promise<{ ok: boolean; mainPath?: string; currentPath?: string; managedRoot?: string; worktrees: GitWorktree[]; error?: string }>;
    create: (cwd: string, options: { ref?: string; name?: string }) => Promise<{ ok: boolean; path?: string; ref?: string; error?: string }>;
    remove: (cwd: string, worktreePath: string) => Promise<{ ok: boolean; error?: string }>;
  };
  net: {
    fetch: (url: string) => Promise<string>;
    search: (query: string) => Promise<string>;
    download: (url: string, dest: string) => Promise<string>;
  };
  skill: {
    list: (rootPath?: string) => Promise<{ global: any[]; project: any[] }>;
    install: (opts: { id: string; content: string; scope: 'global' | 'project'; rootPath?: string }) => Promise<{ ok: boolean; path?: string; error?: string }>;
    remove: (opts: { id: string; scope: 'global' | 'project'; rootPath?: string }) => Promise<{ ok: boolean; error?: string }>;
  };
  memory: {
    list: () => Promise<any[]>;
    save: (entries: any[]) => Promise<boolean>;
  };
  mcp: {
    list: () => Promise<McpToolSummary[]>;
    call: (server: string, tool: string, args: any) => Promise<string>;
    reload: (rootPath?: string) => Promise<McpToolSummary[]>;
    getConfig: () => Promise<any>;
    setConfig: (cfg: any) => Promise<McpToolSummary[]>;
  };
  remote: {
    start: (opts?: { tunnel?: boolean; tunnelConfig?: any }) => Promise<any>;
    stop: () => Promise<any>;
    status: () => Promise<any>;
    setPassword: (pw: string | null) => Promise<any>;
    installNgrok: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    installCloudflared: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    kick: (id: string) => Promise<any>;
    publish: (frame: any) => Promise<boolean>;
    onCommand: (callback: (cmd: any) => void) => () => void;
    onClients: (callback: (count: number) => void) => () => void;
  };
  preview: {
    detect: (cwd: string) => Promise<PreviewPlan | null>;
    start: (opts: { cwd: string; command?: string | null }) => Promise<PreviewStatus>;
    stop: () => Promise<PreviewStatus>;
    status: () => Promise<PreviewStatus>;
    openExternal: (url: string) => Promise<boolean>;
    onStatus: (callback: (status: PreviewStatus) => void) => () => void;
    onLog: (callback: (entry: PreviewLog) => void) => () => void;
    onReload: (callback: () => void) => () => void;
  };
  computer: {
    status: () => Promise<ComputerStatus>;
    setEnabled: (on: boolean) => Promise<ComputerStatus>;
    requestPermissions: () => Promise<ComputerStatus>;
    screenshot: () => Promise<ComputerScreenshot>;
    act: (req: ComputerRequest) => Promise<ComputerActionResult>;
    panic: () => Promise<ComputerStatus>;
  };
  terminal: {
    spawn: (id: string, cwd?: string) => Promise<boolean>;
    write: (id: string, data: string) => Promise<boolean>;
    kill: (id: string) => Promise<boolean>;
    onData: (callback: (payload: { id: string; data: string }) => void) => () => void;
    onExit: (callback: (payload: { id: string; code: number }) => void) => () => void;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
