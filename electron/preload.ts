import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
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
    getSystemInfo: () => ipcRenderer.invoke('app:getSystemInfo'),
    getAppMetrics: () => ipcRenderer.invoke('app:getAppMetrics'),
  },
  git: {
    info: (cwd?: string) => ipcRenderer.invoke('git:info', cwd),
    status: (cwd?: string) => ipcRenderer.invoke('git:status', cwd),
    diff: (cwd?: string, file?: string) => ipcRenderer.invoke('git:diff', cwd, file),
    branches: (cwd?: string) => ipcRenderer.invoke('git:branches', cwd),
    review: (cwd: string, options: any) => ipcRenderer.invoke('git:review', cwd, options),
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
  computer: {
    status: () => ipcRenderer.invoke('computer:status'),
    setEnabled: (on: boolean) => ipcRenderer.invoke('computer:setEnabled', on),
    requestPermissions: () => ipcRenderer.invoke('computer:requestPermissions'),
    screenshot: () => ipcRenderer.invoke('computer:screenshot'),
    act: (req: any) => ipcRenderer.invoke('computer:act', req),
    panic: () => ipcRenderer.invoke('computer:panic'),
  },
  screenshot: {
    capture: () => ipcRenderer.invoke('screenshot:capture'),
    begin: () => ipcRenderer.invoke('screenshot:begin'),
    getImage: () => ipcRenderer.invoke('screenshot:get-image'),
    finish: (dataUrl: string) => ipcRenderer.invoke('screenshot:finish', dataUrl),
    cancel: () => ipcRenderer.invoke('screenshot:cancel'),
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
