import { contextBridge, ipcRenderer } from 'electron';
import type { ComputerPreviewAppearance } from '../src/core/computer/preview';
import type { UpdateDownloadProgress } from '../src/core/updates/updateClient';

contextBridge.exposeInMainWorld('electronAPI', {
  free: {
    status: () => ipcRenderer.invoke('free:status'),
    usageGet: () => ipcRenderer.invoke('free:usage:get'),
    usageRecord: (tokens: number) => ipcRenderer.invoke('free:usage:record', tokens),
    usageSync: (serverResetAt: string | null) => ipcRenderer.invoke('free:usage:sync', serverResetAt),
    usageReset: (serverResetAt: string | null) => ipcRenderer.invoke('free:usage:reset', serverResetAt),
    usageHydrate: (legacy: { weekStart: number; used: number } | null) => ipcRenderer.invoke('free:usage:hydrate', legacy),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
  notification: {
    show: (options: any) => ipcRenderer.invoke('notification:show', options),
  },
  power: {
    setPreventSleep: (on: boolean) => ipcRenderer.invoke('power:setPreventSleep', on),
  },
  provider: {
    list: () => ipcRenderer.invoke('provider:list'),
    create: (config: any) => ipcRenderer.invoke('provider:create', config),
    update: (id: string, config: any) => ipcRenderer.invoke('provider:update', id, config),
    delete: (id: string) => ipcRenderer.invoke('provider:delete', id),
  },
  model: {
    list: (providerId?: string) => ipcRenderer.invoke('model:list', providerId),
    probe: (config: any) => ipcRenderer.invoke('model:probe', config),
  },
  conversation: {
    list: () => ipcRenderer.invoke('conversation:list'),
    create: (data: any) => ipcRenderer.invoke('conversation:create', data),
    update: (id: string, data: any) => ipcRenderer.invoke('conversation:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('conversation:delete', id),
  },
  message: {
    list: (conversationId: string) => ipcRenderer.invoke('message:list', conversationId),
    counts: () => ipcRenderer.invoke('message:counts'),
    create: (data: any) => ipcRenderer.invoke('message:create', data),
    delete: (messageId: string) => ipcRenderer.invoke('message:delete', messageId),
    editAndTruncate: (convId: string, messageId: string, content: string) => ipcRenderer.invoke('message:editAndTruncate', convId, messageId, content),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (data: any) => ipcRenderer.invoke('settings:update', data),
  },
  favorite: {
    list: () => ipcRenderer.invoke('favorite:list'),
    toggle: (modelId: string) => ipcRenderer.invoke('favorite:toggle', modelId),
  },
  recent: {
    list: () => ipcRenderer.invoke('recent:list'),
    add: (modelId: string) => ipcRenderer.invoke('recent:add', modelId),
  },
  chat: {
    stream: (params: any) => ipcRenderer.invoke('chat:stream', params),
    stop: (conversationId?: string) => ipcRenderer.invoke('chat:stop', conversationId),
    onChunk: (callback: (chunk: any) => void) => {
      // Remove any previously-registered listeners so we never accumulate
      // duplicates (which would double/triple every streamed token).
      ipcRenderer.removeAllListeners('chat:chunk');
      const listener = (_: any, chunk: any) => callback(chunk);
      ipcRenderer.on('chat:chunk', listener);
      return () => ipcRenderer.removeListener('chat:chunk', listener);
    },
  },
  dialog: {
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
    saveFile: (defaultPath?: string) => ipcRenderer.invoke('dialog:saveFile', defaultPath),
  },
  fs: {
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
    readFileBase64: (filePath: string) => ipcRenderer.invoke('fs:readFileBase64', filePath),
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
    writeFileBase64: (filePath: string, base64: string) => ipcRenderer.invoke('fs:writeFileBase64', filePath, base64),
    readDir: (dirPath: string) => ipcRenderer.invoke('fs:readDir', dirPath),
    exists: (filePath: string) => ipcRenderer.invoke('fs:exists', filePath),
    createDir: (dirPath: string) => ipcRenderer.invoke('fs:createDir', dirPath),
    deleteFile: (filePath: string) => ipcRenderer.invoke('fs:deleteFile', filePath),
    deleteDir: (dirPath: string) => ipcRenderer.invoke('fs:deleteDir', dirPath),
    rename: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
    move: (srcPath: string, destPath: string) => ipcRenderer.invoke('fs:move', srcPath, destPath),
    copy: (srcPath: string, destPath: string) => ipcRenderer.invoke('fs:copy', srcPath, destPath),
    stat: (filePath: string) => ipcRenderer.invoke('fs:stat', filePath),
    search: (opts: any) => ipcRenderer.invoke('fs:search', opts),
    glob: (opts: any) => ipcRenderer.invoke('fs:glob', opts),
  },
  exec: {
    run: (command: string, cwd?: string, sandbox?: any) => ipcRenderer.invoke('exec:run', command, cwd, sandbox),
    spawn: (command: string, args: string[], cwd?: string) => ipcRenderer.invoke('exec:spawn', command, args, cwd),
  },
  app: {
    open: (appName: string) => ipcRenderer.invoke('app:open', appName),
    openPath: (path: string) => ipcRenderer.invoke('app:openPath', path),
    getPath: (name: string) => ipcRenderer.invoke('app:getPath', name),
    getSystemInfo: () => ipcRenderer.invoke('app:getSystemInfo'),
    getAppMetrics: () => ipcRenderer.invoke('app:getAppMetrics'),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
  },
  git: {
    publishRelease: (options: any) => ipcRenderer.invoke('git:publishRelease', options),
    info: (cwd?: string) => ipcRenderer.invoke('git:info', cwd),
    status: (cwd?: string) => ipcRenderer.invoke('git:status', cwd),
    diff: (cwd?: string, file?: string) => ipcRenderer.invoke('git:diff', cwd, file),
    branches: (cwd?: string) => ipcRenderer.invoke('git:branches', cwd),
    pushProject: (opts: { cwd: string; message?: string; repo?: string; token?: string }) =>
      ipcRenderer.invoke('git:pushProject', opts),
    review: (cwd: string, options: any) => ipcRenderer.invoke('git:review', cwd, options),
  },
  githubReply: {
    list: (options: { repo: string; token?: string }) => ipcRenderer.invoke('github-reply:list', options),
    context: (options: { repo: string; token?: string; number: number }) =>
      ipcRenderer.invoke('github-reply:context', options),
    post: (options: { repo: string; token?: string; number: number; body: string }) =>
      ipcRenderer.invoke('github-reply:post', options),
  },
  worktree: {
    list: (cwd: string) => ipcRenderer.invoke('worktree:list', cwd),
    create: (cwd: string, options: any) => ipcRenderer.invoke('worktree:create', cwd, options),
    remove: (cwd: string, worktreePath: string) => ipcRenderer.invoke('worktree:remove', cwd, worktreePath),
  },
  net: {
    fetch: (url: string, scope?: string) => ipcRenderer.invoke('net:fetch', url, scope),
    search: (query: string, scope?: string) => ipcRenderer.invoke('net:search', query, scope),
    download: (url: string, dest: string) => ipcRenderer.invoke('net:download', url, dest),
  },
  browser: {
    navigate: (url: string, scope?: string) => ipcRenderer.invoke('browser:navigate', url, scope),
    snapshot: () => ipcRenderer.invoke('browser:snapshot'),
    click: (ref: string) => ipcRenderer.invoke('browser:click', ref),
    fill: (ref: string, text: string, submit: boolean) => ipcRenderer.invoke('browser:fill', ref, text, submit),
    eval: (expression: string) => ipcRenderer.invoke('browser:eval', expression),
    history: (action: 'reload' | 'back') => ipcRenderer.invoke('browser:history', action),
    status: () => ipcRenderer.invoke('browser:status'),
    close: () => ipcRenderer.invoke('browser:close'),
  },
  skill: {
    list: (rootPath?: string) => ipcRenderer.invoke('skill:list', rootPath),
    install: (opts: any) => ipcRenderer.invoke('skill:install', opts),
    remove: (opts: any) => ipcRenderer.invoke('skill:remove', opts),
  },
  memory: {
    list: () => ipcRenderer.invoke('memory:list'),
    save: (entries: any[]) => ipcRenderer.invoke('memory:save', entries),
  },
  memory2: {
    setRoot: (rootPath: string | null) => ipcRenderer.invoke('memory2:setRoot', rootPath),
    load: () => ipcRenderer.invoke('memory2:load'),
    save: (state: any) => ipcRenderer.invoke('memory2:save', state),
    backup: () => ipcRenderer.invoke('memory2:backup'),
    restore: () => ipcRenderer.invoke('memory2:restore'),
    putObject: (key: string, content: string) => ipcRenderer.invoke('memory2:putObject', key, content),
    listObjects: (prefix: string) => ipcRenderer.invoke('memory2:listObjects', prefix),
    deleteObject: (key: string) => ipcRenderer.invoke('memory2:deleteObject', key),
    getObject: (key: string) => ipcRenderer.invoke('memory2:getObject', key),
    deviceId: () => ipcRenderer.invoke('memory2:deviceId'),
    legacySnapshot: () => ipcRenderer.invoke('memory2:legacySnapshot'),
    projectId: (rootPath: string) => ipcRenderer.invoke('memory2:projectId', rootPath),
  },
  memoryDrive: {
    status: () => ipcRenderer.invoke('memory-drive:status'),
    configure: (opts: any) => ipcRenderer.invoke('memory-drive:configure', opts),
    connect: (opts?: any) => ipcRenderer.invoke('memory-drive:connect', opts),
    disconnect: () => ipcRenderer.invoke('memory-drive:disconnect'),
    health: () => ipcRenderer.invoke('memory-drive:health'),
    search: (tenantId: string, query: any) => ipcRenderer.invoke('memory-drive:search', tenantId, query),
    remoteChanges: (tenantId: string, since: number, limit?: number) => ipcRenderer.invoke('memory-drive:remoteChanges', tenantId, since, limit),
    pushChanges: (tenantId: string, changes: any[]) => ipcRenderer.invoke('memory-drive:pushChanges', tenantId, changes),
    backup: (tenantId: string) => ipcRenderer.invoke('memory-drive:backup', tenantId),
    restore: (tenantId: string) => ipcRenderer.invoke('memory-drive:restore', tenantId),
    restoreSnapshot: (tenantId: string) => ipcRenderer.invoke('memory-drive:restoreSnapshot', tenantId),
    putObject: (tenantId: string, key: string, content: string) => ipcRenderer.invoke('memory-drive:putObject', tenantId, key, content),
    getObject: (tenantId: string, key: string) => ipcRenderer.invoke('memory-drive:getObject', tenantId, key),
    usage: (tenantId: string) => ipcRenderer.invoke('memory-drive:usage', tenantId),
    devices: (tenantId: string) => ipcRenderer.invoke('memory-drive:devices', tenantId),
    revokeDevice: (tenantId: string, deviceId: string) => ipcRenderer.invoke('memory-drive:revokeDevice', tenantId, deviceId),
    deleteTenantData: (tenantId: string) => ipcRenderer.invoke('memory-drive:deleteTenantData', tenantId),
  },
  dshMarket: {
    snapshot: (query?: any) => ipcRenderer.invoke('dsh-market:snapshot', query),
    detail: (pluginId: string, version?: string) => ipcRenderer.invoke('dsh-market:detail', pluginId, version),
    versions: (pluginId: string) => ipcRenderer.invoke('dsh-market:versions', pluginId),
    inspectRepository: (input: string, ref?: string, subdir?: string) => ipcRenderer.invoke('dsh-market:inspect-repository', input, ref, subdir),
    installRepository: (profileId: string, input: string, ref?: string, subdir?: string, opts?: any) => ipcRenderer.invoke('dsh-market:install-repository', profileId, input, ref, subdir, opts),
    refreshSources: (sourceId?: string) => ipcRenderer.invoke('dsh-market:refresh-sources', sourceId),
    addRemoteSource: (url: string, title?: string) => ipcRenderer.invoke('dsh-market:add-remote-source', url, title),
    addLocalSource: () => ipcRenderer.invoke('dsh-market:add-local-source'),
    removeSource: (sourceId: string) => ipcRenderer.invoke('dsh-market:remove-source', sourceId),
    inspectLocal: () => ipcRenderer.invoke('dsh-market:inspect-local'),
    installLocal: (profileId: string, directory: string, opts?: any) => ipcRenderer.invoke('dsh-market:install-local', profileId, directory, opts),
    install: (profileId: string, pluginId: string, version?: string, opts?: any) => ipcRenderer.invoke('dsh-market:install', profileId, pluginId, version, opts),
    rollback: (profileId: string, pluginId: string, version?: string) => ipcRenderer.invoke('dsh-market:rollback', profileId, pluginId, version),
    uninstall: (profileId: string, pluginId: string, deleteData?: boolean) => ipcRenderer.invoke('dsh-market:uninstall', profileId, pluginId, deleteData),
    setEnabled: (profileId: string, pluginId: string, enabled: boolean) => ipcRenderer.invoke('dsh-market:set-enabled', profileId, pluginId, enabled),
    saveConfig: (profileId: string, pluginId: string, configs: Record<string, unknown>) => ipcRenderer.invoke('dsh-market:save-config', profileId, pluginId, configs),
    cancel: (requestId: string) => ipcRenderer.invoke('dsh-market:cancel', requestId),
    logs: (profileId: string, pluginId: string) => ipcRenderer.invoke('dsh-market:logs', profileId, pluginId),
    contributions: (profileId: string, pluginId?: string) => ipcRenderer.invoke('dsh-market:contributions', profileId, pluginId),
    invokeTool: (profileId: string, pluginId: string, tool: string, args: unknown, rowId?: string) => ipcRenderer.invoke('dsh-market:invoke-tool', profileId, pluginId, tool, args, rowId),
    invokeCommand: (profileId: string, pluginId: string, command: string, rawInput: string, rowId?: string) => ipcRenderer.invoke('dsh-market:invoke-command', profileId, pluginId, command, rawInput, rowId),
    skills: () => ipcRenderer.invoke('dsh-market:skills'),
    skillContent: (pluginId: string, name: string) => ipcRenderer.invoke('dsh-market:skill-content', pluginId, name),
    switchProfile: (profileId: string) => ipcRenderer.invoke('dsh-market:switch-profile', profileId),
    createProfile: (profileId: string, name?: string) => ipcRenderer.invoke('dsh-market:create-profile', profileId, name),
    restartRuntime: () => ipcRenderer.invoke('dsh-market:restart-runtime'),
    openExternal: (url: string) => ipcRenderer.invoke('dsh-market:open-external', url),
    revealPath: (target: string) => ipcRenderer.invoke('dsh-market:reveal-path', target),
    revealLog: (profileId: string, pluginId: string) => ipcRenderer.invoke('dsh-market:reveal-log', profileId, pluginId),
    onEvent: (callback: (event: any) => void) => {
      const listener = (_: any, event: any) => callback(event);
      ipcRenderer.on('dsh-market:event', listener);
      return () => ipcRenderer.removeListener('dsh-market:event', listener);
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    call: (server: string, tool: string, args: any) => ipcRenderer.invoke('mcp:call', server, tool, args),
    reload: (rootPath?: string) => ipcRenderer.invoke('mcp:reload', rootPath),
    getConfig: () => ipcRenderer.invoke('mcp:getConfig'),
    setConfig: (cfg: any) => ipcRenderer.invoke('mcp:setConfig', cfg),
  },
  remote: {
    start: (opts?: { tunnel?: boolean }) => ipcRenderer.invoke('remote:start', opts),
    stop: () => ipcRenderer.invoke('remote:stop'),
    status: () => ipcRenderer.invoke('remote:status'),
    setPassword: (pw: string | null) => ipcRenderer.invoke('remote:setPassword', pw),
    installNgrok: () => ipcRenderer.invoke('remote:installNgrok'),
    installCloudflared: () => ipcRenderer.invoke('remote:installCloudflared'),
    kick: (id: string) => ipcRenderer.invoke('remote:kick', id),
    publish: (frame: any) => ipcRenderer.invoke('remote:publish', frame),
    onCommand: (callback: (cmd: any) => void) => {
      ipcRenderer.removeAllListeners('remote:command');
      const listener = (_: any, cmd: any) => callback(cmd);
      ipcRenderer.on('remote:command', listener);
      return () => ipcRenderer.removeListener('remote:command', listener);
    },
    onClients: (callback: (count: number) => void) => {
      ipcRenderer.removeAllListeners('remote:clients');
      const listener = (_: any, count: number) => callback(count);
      ipcRenderer.on('remote:clients', listener);
      return () => ipcRenderer.removeListener('remote:clients', listener);
    },
  },
  preview: {
    detect: (cwd: string) => ipcRenderer.invoke('preview:detect', cwd),
    start: (opts: { cwd: string; command?: string | null }) => ipcRenderer.invoke('preview:start', opts),
    stop: () => ipcRenderer.invoke('preview:stop'),
    status: () => ipcRenderer.invoke('preview:status'),
    openExternal: (url: string) => ipcRenderer.invoke('preview:openExternal', url),
    onStatus: (callback: (status: any) => void) => {
      ipcRenderer.removeAllListeners('preview:status');
      const listener = (_: any, status: any) => callback(status);
      ipcRenderer.on('preview:status', listener);
      return () => ipcRenderer.removeListener('preview:status', listener);
    },
    onLog: (callback: (entry: { stream: string; data: string }) => void) => {
      ipcRenderer.removeAllListeners('preview:log');
      const listener = (_: any, entry: any) => callback(entry);
      ipcRenderer.on('preview:log', listener);
      return () => ipcRenderer.removeListener('preview:log', listener);
    },
    // Static previews have no HMR — main watches the folder and pings here.
    onReload: (callback: () => void) => {
      ipcRenderer.removeAllListeners('preview:reload');
      const listener = () => callback();
      ipcRenderer.on('preview:reload', listener);
      return () => ipcRenderer.removeListener('preview:reload', listener);
    },
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: (url: string, fileName?: string) => ipcRenderer.invoke('update:download', url, fileName),
    reveal: (filePath: string) => ipcRenderer.invoke('update:reveal', filePath),
    onProgress: (callback: (progress: UpdateDownloadProgress) => void) => {
      const listener = (_: unknown, progress: UpdateDownloadProgress) => callback(progress);
      ipcRenderer.on('update:download-progress', listener);
      return () => ipcRenderer.removeListener('update:download-progress', listener);
    },
  },
  computer: {
    openPreview: (appearance?: ComputerPreviewAppearance) => ipcRenderer.invoke('computer-preview:open', appearance),
    closePreview: () => ipcRenderer.invoke('computer-preview:close'),
    previewStatus: () => ipcRenderer.invoke('computer-preview:get-visibility'),
    onPreviewVisibility: (callback: (status: { visible: boolean }) => void) => {
      const listener = (_event: unknown, status: { visible: boolean }) => callback(status);
      ipcRenderer.on('computer-preview:visibility-changed', listener);
      return () => ipcRenderer.removeListener('computer-preview:visibility-changed', listener);
    },
    onStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: unknown, status: unknown) => callback(status);
      ipcRenderer.on('computer:status-changed', listener);
      return () => ipcRenderer.removeListener('computer:status-changed', listener);
    },
    status: () => ipcRenderer.invoke('computer:status'),
    setEnabled: (on: boolean) => ipcRenderer.invoke('computer:setEnabled', on),
    requestPermissions: () => ipcRenderer.invoke('computer:requestPermissions'),
    openScreenSettings: () => ipcRenderer.invoke('computer:openScreenSettings'),
    screenshot: (expectedRevision?: number) => ipcRenderer.invoke('computer:screenshot', expectedRevision),
    act: (req: any) => ipcRenderer.invoke('computer:act', req),
    panic: () => ipcRenderer.invoke('computer:panic'),
  },
  screenshot: {
    capture: () => ipcRenderer.invoke('screenshot:capture'),
    begin: () => ipcRenderer.invoke('screenshot:begin'),
    getImage: () => ipcRenderer.invoke('screenshot:get-image'),
    ready: (session: number) => ipcRenderer.invoke('screenshot:ready', session),
    finish: (dataUrl: string) => ipcRenderer.invoke('screenshot:finish', dataUrl),
    cancel: () => ipcRenderer.invoke('screenshot:cancel'),
    onImage: (callback: (image: { dataUrl: string; width: number; height: number; session: number }) => void) => {
      const listener = (_: unknown, image: any) => callback(image);
      ipcRenderer.on('screenshot:image', listener);
      return () => ipcRenderer.removeListener('screenshot:image', listener);
    },
    onReset: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('screenshot:reset', listener);
      return () => ipcRenderer.removeListener('screenshot:reset', listener);
    },
    onResult: (callback: (dataUrl: string) => void) => {
      const listener = (_: unknown, dataUrl: string) => callback(dataUrl);
      ipcRenderer.on('screenshot:result', listener);
      return () => ipcRenderer.removeListener('screenshot:result', listener);
    },
    save: (dataUrl: string) => ipcRenderer.invoke('screenshot:save', dataUrl),
    setShortcut: (accelerator: string | null) => ipcRenderer.invoke('screenshot:set-shortcut', accelerator),
    openSettings: () => ipcRenderer.invoke('screenshot:open-settings'),
    relaunch: () => ipcRenderer.invoke('screenshot:relaunch'),
    onTrigger: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('screenshot:trigger', listener);
      return () => ipcRenderer.removeListener('screenshot:trigger', listener);
    },
  },
  terminal: {
    spawn: (id: string, cwd?: string) => ipcRenderer.invoke('terminal:spawn', id, cwd),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    kill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
    onData: (callback: (payload: { id: string; data: string }) => void) => {
      const listener = (_: any, payload: { id: string; data: string }) => callback(payload);
      ipcRenderer.on('terminal:data', listener);
      return () => ipcRenderer.removeListener('terminal:data', listener);
    },
    onExit: (callback: (payload: { id: string; code: number }) => void) => {
      const listener = (_: any, payload: { id: string; code: number }) => callback(payload);
      ipcRenderer.on('terminal:exit', listener);
      return () => ipcRenderer.removeListener('terminal:exit', listener);
    },
  },
});
// Trigger renderer reload for settings UI update
