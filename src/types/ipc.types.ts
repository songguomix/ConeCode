import type { AIModel } from './model.types';
import type { Conversation, Message } from './chat.types';
import type { ProviderConfig } from './provider.types';
import type {
  ReplyContextRequest,
  ReplyContextResult,
  ReplyListRequest,
  ReplyListResult,
  ReplyPostRequest,
  ReplyPostResult,
} from './githubReply.types';
// The preview's shapes are defined next to its logic and shared with main.
import type { PreviewPlan, PreviewStatus, PreviewLog } from '../core/preview/preview';
import type { ComputerFrame, ComputerRequest, ComputerTarget, DisplayGeometry } from '../core/computer/computer';
import type { ComputerPreviewAPI, ComputerPreviewAppearance, ComputerPreviewStatus } from '../core/computer/preview';
import type {
  CloudUsage, GoogleDriveStatus, Memory2State, MemoryChange, MemoryConflict,
  MemoryQuery, SearchHit, StorageHealth,
} from '../core/memory/v2/types';
import type {
  CatalogQuery,
  InstalledPlugin,
  InvokeResult,
  LogsResult,
  MarketEvent,
  MarketPlugin,
  MarketProfile,
  MarketSnapshot,
  MarketSource,
  MarketVersion,
  PluginContributions,
  PluginDetail,
  RepositoryInspection,
  SkillContribution,
} from '../core/dsh-market/types';

export type { PreviewPlan, PreviewStatus, PreviewLog };
export type { ComputerRequest, DisplayGeometry };

export interface AppProcessMetric {
  pid: number;
  type: string;
  /** Percent CPU usage. */
  cpu: number;
  /** Working set in KB. */
  memory: number;
}

export interface AppMetricsSnapshot {
  processes: AppProcessMetric[];
  mainMemory: { rss: number; heapUsed: number; heapTotal: number };
  load: number[];
  freeMemory: number;
  totalMemory: number;
  cpus: number;
}

export type ComputerStatus = ComputerPreviewStatus;

export interface ComputerActionResult {
  ok: boolean;
  message: string;
  cursor?: [number, number];
  needsPermission?: 'accessibility' | 'screenRecording';
  target?: ComputerTarget;
  targets?: ComputerTarget[];
}

export type ComputerScreenshot =
  | ComputerFrame
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
  'message:counts': { result: Record<string, number> };
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

/** Search/glob result plus whether the list stopped at the cap (more may exist). */
export interface SearchScanResult {
  matches: SearchMatch[];
  capped: boolean;
}

export interface GlobScanResult {
  files: string[];
  capped: boolean;
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
  /** Binds an attached Computer Use image to the current native window frame. */
  computerFrameId?: string;
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
  free: {
    status: () => Promise<import('../core/providers/free.adapter').FreeStatus>;
    // Durable weekly-usage store (main-process file). Optional so older test
    // stubs that only mock `status` still satisfy the shape.
    usageGet?: () => Promise<import('../core/providers/freeUsage').FreeWeeklyUsageRecord | null>;
    usageRecord?: (tokens: number) => Promise<import('../core/providers/freeUsage').FreeWeeklyUsageRecord>;
    usageSync?: (serverResetAt: string | null) => Promise<{ record: import('../core/providers/freeUsage').FreeWeeklyUsageRecord; changed: boolean }>;
    usageReset?: (serverResetAt: string | null) => Promise<import('../core/providers/freeUsage').FreeWeeklyUsageRecord>;
    usageHydrate?: (legacy: import('../core/providers/freeUsage').FreeWeeklyUsageRecord | null) => Promise<import('../core/providers/freeUsage').FreeWeeklyUsageRecord>;
  };
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
    /** Message count per conversation (including never-used ones as absent/0). */
    counts: () => Promise<Record<string, number>>;
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
    search: (opts: { query: string; dir?: string; isRegex?: boolean; maxResults?: number }) => Promise<SearchScanResult>;
    glob: (opts: { pattern: string; dir?: string; maxResults?: number }) => Promise<GlobScanResult>;
  };
  exec: {
    run: (command: string, cwd?: string, sandbox?: SandboxRequest) => Promise<ExecResult>;
    spawn: (command: string, args: string[], cwd?: string) => Promise<ExecResult>;
  };
  app: {
    open: (appName: string) => Promise<boolean>;
    openPath: (path: string) => Promise<boolean>;
    getSystemInfo: () => Promise<Record<string, any>>;
    getAppMetrics: () => Promise<AppMetricsSnapshot>;
    getVersion: () => Promise<string>;
  };
  /** Self-update: metadata from agibase, installer fetched by Chromium. */
  update: {
    check: () => Promise<import('../core/updates/updateClient').UpdateCheckResult>;
    download: (url: string, fileName?: string) => Promise<import('../core/updates/updateClient').UpdateDownloadStart>;
    reveal: (filePath: string) => Promise<boolean>;
    onProgress: (callback: (progress: import('../core/updates/updateClient').UpdateDownloadProgress) => void) => () => void;
  };
  git: {
    publishRelease: (options: { repo: string; token: string; tag: string; name?: string; body?: string; target: string; files: string[]; draft?: boolean; prerelease?: boolean }) => Promise<{ ok: boolean; message: string; url?: string }>;
    info: (cwd?: string) => Promise<{ isRepo: boolean; branch: string | null; dirty: number }>;
    status: (cwd?: string) => Promise<string>;
    diff: (cwd?: string, file?: string) => Promise<string>;
    branches: (cwd?: string) => Promise<string[]>;
    pushProject: (opts: { cwd: string; message?: string; repo?: string; token?: string }) =>
      Promise<{ ok: boolean; message: string }>;
    review: (cwd: string, options: {
      scope: 'uncommitted' | 'base' | 'commit';
      target?: string;
    }) => Promise<{ ok: boolean; status?: string; diff?: string; error?: string; scope?: string; target?: string | null }>;
  };
  /** GitHub plugin: manual reply assistant for open issues and pull requests. */
  githubReply: {
    list: (options: ReplyListRequest) => Promise<ReplyListResult>;
    context: (options: ReplyContextRequest) => Promise<ReplyContextResult>;
    post: (options: ReplyPostRequest) => Promise<ReplyPostResult>;
  };
  worktree: {
    list: (cwd: string) => Promise<{ ok: boolean; mainPath?: string; currentPath?: string; managedRoot?: string; worktrees: GitWorktree[]; error?: string }>;
    create: (cwd: string, options: { ref?: string; name?: string }) => Promise<{ ok: boolean; path?: string; ref?: string; error?: string }>;
    remove: (cwd: string, worktreePath: string) => Promise<{ ok: boolean; error?: string }>;
  };
  net: {
    fetch: (url: string, scope?: string) => Promise<string>;
    search: (query: string, scope?: string) => Promise<string>;
    download: (url: string, dest: string) => Promise<string>;
  };
  /**
   * Headless BrowserUse — the built-in browser for the open web. Same
   * ref-annotated driving as the preview panel's page_* tools, for any https
   * URL with no project or panel needed. navigate hands back a snapshot; the
   * refs it contains drive click/fill until the page changes.
   */
  browser: {
    navigate: (url: string, scope?: string) => Promise<{ ok: boolean; url?: string; snapshot?: string; error?: string }>;
    snapshot: () => Promise<string>;
    click: (ref: string) => Promise<string>;
    fill: (ref: string, text: string, submit: boolean) => Promise<string>;
    eval: (expression: string) => Promise<string>;
    history: (action: 'reload' | 'back') => Promise<string>;
    status: () => Promise<{ active: boolean }>;
    close: () => Promise<void>;
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
  /** Memory 2.0 main-process bridge. Optional so older runtimes keep working. */
  memory2?: {
    setRoot: (rootPath: string | null) => Promise<boolean>;
    load: () => Promise<Memory2State | null>;
    save: (state: Memory2State) => Promise<boolean>;
    backup: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    restore: () => Promise<{ ok: boolean; state?: Memory2State; error?: string }>;
    putObject: (key: string, content: string) => Promise<boolean>;
    getObject: (key: string) => Promise<string | null>;
    listObjects: (prefix: string) => Promise<string[]>;
    deleteObject: (key: string) => Promise<boolean>;
    deviceId: () => Promise<string>;
    legacySnapshot: () => Promise<{ entries: any[]; files: { path: string; scope: string; content: string }[] }>;
    projectId: (rootPath: string) => Promise<string>;
  };
  /** Google Drive memory bridge. OAuth tokens stay in the main process. */
  memoryDrive?: {
    status: () => Promise<GoogleDriveStatus>;
    configure: (opts: { clientId?: string; clientSecret?: string }) => Promise<GoogleDriveStatus>;
    connect: (opts?: { clientId?: string; clientSecret?: string }) => Promise<{ ok: boolean; status?: GoogleDriveStatus; error?: string }>;
    disconnect: () => Promise<boolean>;
    health: () => Promise<StorageHealth>;
    search: (tenantId: string, query: MemoryQuery) => Promise<SearchHit[]>;
    remoteChanges: (tenantId: string, since: number, limit?: number) => Promise<{ changes: MemoryChange[]; cursor: number; error?: string }>;
    pushChanges: (tenantId: string, changes: MemoryChange[]) => Promise<{ ok: boolean; acceptedChangeIds: string[]; cursor: number; conflicts: MemoryConflict[]; error?: string }>;
    backup: (tenantId: string) => Promise<string | null>;
    restore: (tenantId: string) => Promise<boolean>;
    restoreSnapshot: (tenantId: string) => Promise<Memory2State | null>;
    putObject: (tenantId: string, key: string, content: string) => Promise<boolean>;
    getObject: (tenantId: string, key: string) => Promise<string | null>;
    usage: (tenantId: string) => Promise<CloudUsage | null>;
    devices: (tenantId: string) => Promise<{ deviceId: string; lastSeenAt: number }[]>;
    revokeDevice: (tenantId: string, deviceId: string) => Promise<boolean>;
    deleteTenantData: (tenantId: string) => Promise<boolean>;
  };
  dshMarket: {
    snapshot: (query?: CatalogQuery) => Promise<MarketSnapshot>;
    detail: (pluginId: string, version?: string) => Promise<PluginDetail>;
    versions: (pluginId: string) => Promise<{ latest: string | null; versions: string[] }>;
    inspectRepository: (input: string, ref?: string, subdir?: string) => Promise<RepositoryInspection>;
    installRepository: (profileId: string, input: string, ref?: string, subdir?: string, opts?: { acceptRisk?: boolean; allowScripts?: boolean }) => Promise<InstalledPlugin>;
    refreshSources: (sourceId?: string) => Promise<MarketSource[]>;
    addRemoteSource: (url: string, title?: string) => Promise<MarketSource>;
    addLocalSource: () => Promise<MarketSource | null>;
    removeSource: (sourceId: string) => Promise<boolean>;
    inspectLocal: () => Promise<{ plugin: MarketPlugin; version: MarketVersion; warnings: string[] } | null>;
    installLocal: (profileId: string, directory: string, opts?: { acceptRisk?: boolean; allowScripts?: boolean }) => Promise<InstalledPlugin>;
    install: (profileId: string, pluginId: string, version?: string, opts?: { acceptRisk?: boolean; allowScripts?: boolean }) => Promise<InstalledPlugin>;
    rollback: (profileId: string, pluginId: string, version?: string) => Promise<InstalledPlugin>;
    uninstall: (profileId: string, pluginId: string, deleteData?: boolean) => Promise<void>;
    setEnabled: (profileId: string, pluginId: string, enabled: boolean) => Promise<InstalledPlugin>;
    saveConfig: (profileId: string, pluginId: string, configs: Record<string, unknown>) => Promise<InstalledPlugin>;
    cancel: (requestId: string) => Promise<boolean>;
    logs: (profileId: string, pluginId: string) => Promise<LogsResult>;
    contributions: (profileId: string, pluginId?: string) => Promise<PluginContributions>;
    invokeTool: (profileId: string, pluginId: string, tool: string, args: unknown, rowId?: string) => Promise<InvokeResult>;
    invokeCommand: (profileId: string, pluginId: string, command: string, rawInput: string, rowId?: string) => Promise<InvokeResult>;
    skills: () => Promise<SkillContribution[]>;
    skillContent: (pluginId: string, name: string) => Promise<string | null>;
    switchProfile: (profileId: string) => Promise<void>;
    createProfile: (profileId: string, name?: string) => Promise<MarketProfile>;
    restartRuntime: () => Promise<void>;
    openExternal: (url: string) => Promise<boolean>;
    revealPath: (target: string) => Promise<boolean>;
    revealLog: (profileId: string, pluginId: string) => Promise<string>;
    onEvent: (callback: (event: MarketEvent) => void) => () => void;
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
    openPreview: (appearance?: ComputerPreviewAppearance) => Promise<{ ok: boolean; error?: string }>;
    closePreview: () => Promise<void>;
    previewStatus: () => Promise<{ visible: boolean }>;
    onPreviewVisibility: (callback: (status: { visible: boolean }) => void) => () => void;
    onStatus: (callback: (status: ComputerStatus) => void) => () => void;
    status: () => Promise<ComputerStatus>;
    setEnabled: (on: boolean) => Promise<ComputerStatus>;
    requestPermissions: () => Promise<ComputerStatus>;
    openScreenSettings: () => Promise<void>;
    screenshot: (expectedRevision?: number) => Promise<ComputerScreenshot>;
    act: (req: ComputerRequest) => Promise<ComputerActionResult>;
    panic: () => Promise<ComputerStatus>;
  };
  screenshot: {
    capture: () => Promise<
      | { dataUrl: string; width: number; height: number }
      | { error: string; needsPermission?: string }
    >;
    save: (dataUrl: string) => Promise<{ ok: boolean; path?: string }>;
    setShortcut: (accelerator: string | null) => Promise<{ ok: boolean }>;
    begin: () => Promise<{ ok: boolean; error?: string; needsPermission?: string }>;
    getImage: () => Promise<
      | { dataUrl: string; width: number; height: number; session: number }
      | { error: string; needsPermission?: string }
    >;
    ready: (session: number) => Promise<{ ok: boolean }>;
    finish: (dataUrl: string) => Promise<{ ok: boolean }>;
    cancel: () => Promise<{ ok: boolean }>;
    onImage: (callback: (image: { dataUrl: string; width: number; height: number; session: number }) => void) => () => void;
    onReset: (callback: () => void) => () => void;
    onResult: (callback: (dataUrl: string) => void) => () => void;
    openSettings: () => Promise<{ ok: boolean }>;
    relaunch: () => Promise<{ ok: boolean }>;
    onTrigger: (callback: () => void) => () => void;
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
    computerPreviewAPI: ComputerPreviewAPI;
  }
}
