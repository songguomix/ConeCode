import { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, shell, Notification, powerSaveBlocker } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec, spawn, execSync } from 'child_process';
import os from 'os';
import { providerRepo } from '../src/core/storage/repositories/provider.repo';
import { modelRepo } from '../src/core/storage/repositories/model.repo';
import { conversationRepo, messageRepo } from '../src/core/storage/repositories/conversation.repo';
import { providerRegistry } from '../src/core/providers/registry';
import { readJSON, writeJSON } from '../src/core/storage/database';
import { mcpManager, type McpServerConfig } from '../src/core/mcp/client';
import {
  resolveSandboxCommand, looksLikeSandboxDenial, SANDBOX_DENIAL_HINT,
  type SandboxMode,
} from '../src/core/exec/sandbox';
import { parseSkill, isSafeSkillId, SKILL_FILE } from '../src/core/skills/skills';
import { remoteServer } from './remote/server';
import { startTunnel, stopTunnel } from './remote/tunnel';
import { previewManager, detectPreview } from './preview/devserver';
import { computerController } from './computer/controller';
import type { ProviderConfig } from '../src/types';

let mainWindow: BrowserWindow | null = null;
// One abort controller per concurrently running conversation. Keyed by the
// conversation id the renderer passes with each chat:stream call, so several
// chats (even on the same model) can stream at the same time without
// cancelling each other.
const mainStreamControllers = new Map<string, AbortController>();
let powerSaveBlockerId: number | null = null;
const terminals = new Map<string, import('child_process').ChildProcess>();

// Remote-control (phone) state. The tunnel URL (if any) already carries the
// pairing token so it is shareable as-is.
let remoteTunnelUrl: string | null = null;
let remoteWired = false;
// Preview streams (status/log/reload) are forwarded to the renderer once.
let previewWired = false;

// Non-internal IPv4 addresses, for the "scan to connect on Wi-Fi" URLs.
function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function remoteStatus() {
  const running = remoteServer.isRunning();
  const port = remoteServer.port;
  const token = remoteServer.token;
  // The password rides in the QR/URL (so scanning auto-connects); it's URL-encoded.
  const pw = remoteServer.getPassword();
  const pwq = pw ? `&p=${encodeURIComponent(pw)}` : '';
  // Pairing URL carries this install's TLS fingerprint so the phone can pin it.
  const fp = remoteServer.fingerprint;
  const fpq = fp ? `&fp=${fp}` : '';
  const lanUrls = running && port && token
    ? lanAddresses().map((ip) => `https://${ip}:${port}/?t=${token}${pwq}${fpq}`)
    : [];
  return {
    running,
    port,
    token,
    lanUrls,
    tunnelUrl: running && remoteTunnelUrl ? remoteTunnelUrl + pwq + fpq : null,
    clients: remoteServer.clientCount(),
    devices: remoteServer.clientList(),
    hasPassword: remoteServer.hasPassword(),
    fingerprint: remoteServer.fingerprint,
  };
}

// When launched from Finder/Dock, a GUI app only inherits a minimal PATH, so
// tools installed via Homebrew, nvm, etc. ("node", "npm", "git") aren't found.
// Resolve the user's real login-shell environment once and reuse it for exec.
let cachedShellEnv: NodeJS.ProcessEnv | null = null;
function getShellEnv(): NodeJS.ProcessEnv {
  if (cachedShellEnv) return cachedShellEnv;
  cachedShellEnv = { ...process.env };
  if (process.platform !== 'win32') {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const out = execSync(`${shell} -lic 'echo __CONECODE_PATH__:$PATH'`, {
        timeout: 5000,
        encoding: 'utf-8',
      });
      const m = out.match(/__CONECODE_PATH__:(.*)/);
      if (m && m[1].trim()) cachedShellEnv.PATH = m[1].trim();
    } catch {
      // Fall back to the inherited PATH if the probe fails.
    }
  }
  return cachedShellEnv;
}

// Run a git subcommand in `cwd` using the user's login-shell PATH (so a
// Finder-launched app still finds git). Read-only by callers; never throws.
function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      const proc = spawn('git', args, { cwd, env: getShellEnv() });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      proc.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }));
    } catch (err: any) {
      resolve({ code: 1, stdout: '', stderr: err?.message || String(err) });
    }
  });
}

function validGitRevision(value: string): boolean {
  return !!value && value.length <= 240 && !value.startsWith('-') && !value.includes('\0');
}

function parseWorktreeList(raw: string, mainPath: string, managedRoot: string) {
  return raw.trim().split(/\n\s*\n/).filter(Boolean).map((block) => {
    const lines = block.split('\n');
    const value = (prefix: string) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) || '';
    const worktreePath = value('worktree ');
    const branchRef = value('branch ');
    const relative = path.relative(managedRoot, worktreePath);
    return {
      path: worktreePath,
      head: value('HEAD '),
      branch: branchRef.replace(/^refs\/heads\//, '') || null,
      detached: lines.includes('detached'),
      locked: lines.some((line) => line.startsWith('locked')),
      prunable: lines.some((line) => line.startsWith('prunable')),
      isMain: path.resolve(worktreePath) === path.resolve(mainPath),
      managed: !!worktreePath && relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative),
    };
  });
}

// ---- Command sandboxing ----------------------------------------------------
// Agent-proposed commands used to run with the user's full authority. Under
// seatbelt they can still read the machine and use the network, but may only
// WRITE inside the workspace and scratch space (see core/exec/sandbox.ts).

interface SandboxRequest {
  mode: SandboxMode;
  allowNetwork?: boolean;
  /** Extra absolute roots the command may write to (e.g. tool caches). */
  extraWritableRoots?: string[];
  /** Permit hdiutil disk-image create, attach, and detach operations. */
  allowDiskImages?: boolean;
}

/**
 * Confine an agent-run command. All of the policy logic lives in
 * core/exec/sandbox.ts so it can be tested against real processes; this only
 * supplies the app-specific bit (where to keep the policy file).
 */
function resolveSandbox(
  command: string,
  cwd: string | undefined,
  req: SandboxRequest | undefined,
): { command: string; sandboxed: boolean } {
  return resolveSandboxCommand({
    command,
    cwd,
    request: req,
    profileDir: app.getPath('userData'),
  });
}

// ---- Web tools -------------------------------------------------------------
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

async function netFetch(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (ConeCode)' } });
    clearTimeout(timer);
    const ct = res.headers.get('content-type') || '';
    const raw = await res.text();
    const body = (ct.includes('html') || /<html/i.test(raw.slice(0, 500))) ? htmlToText(raw) : raw;
    return `URL: ${url}\nStatus: ${res.status} ${res.statusText}\n\n${body.slice(0, 15000)}`;
  } catch (e: any) {
    return `Error fetching ${url}: ${e?.message || String(e)}`;
  }
}

async function netSearch(query: string): Promise<string> {
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': 'Mozilla/5.0 (ConeCode)' },
    });
    const html = await res.text();
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && out.length < 8) {
      const uddg = m[1].match(/uddg=([^&]+)/)?.[1];
      const link = uddg ? decodeURIComponent(uddg) : m[1];
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (title) out.push(`${out.length + 1}. ${title}\n   ${link}`);
    }
    return out.length ? `Web results for "${query}":\n\n${out.join('\n')}` : `No web results for "${query}".`;
  } catch (e: any) {
    return `Search error: ${e?.message || String(e)}`;
  }
}

// Download a file from a URL to an absolute path (the agent's `download` action).
async function netDownload(url: string, dest: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (ConeCode)' } });
    clearTimeout(timer);
    if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText} downloading ${url}`;
    const buf = Buffer.from(await res.arrayBuffer());
    const resolved = path.isAbsolute(dest) ? dest : path.join(process.cwd(), dest);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, buf);
    return `Downloaded ${buf.length} bytes from ${url} to ${resolved}`;
  } catch (e: any) {
    return `Error downloading ${url}: ${e?.message || String(e)}`;
  }
}

// Download + extract the official ngrok agent into <userData>/bin so the public
// tunnel can use it without the user installing anything (one-click from the
// remote panel). Returns the binary path or an error.
async function installNgrok(): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const osName = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
    const ext = osName === 'linux' ? 'tgz' : 'zip';
    const url = `https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-${osName}-${arch}.${ext}`;
    const binDir = path.join(app.getPath('userData'), 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const archive = path.join(binDir, `ngrok-download.${ext}`);
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (ConeCode)' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} downloading ngrok` };
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    // Extract with the OS's own tools (no extra deps): unzip on macOS, tar -xf on
    // Windows (bsdtar reads zip), tar -xzf for the Linux .tgz.
    const q = (s: string) => JSON.stringify(s);
    const cmd = ext === 'tgz'
      ? `tar -xzf ${q(archive)} -C ${q(binDir)}`
      : osName === 'windows'
        ? `tar -xf ${q(archive)} -C ${q(binDir)}`
        : `unzip -o ${q(archive)} -d ${q(binDir)}`;
    execSync(cmd, { env: getShellEnv() });
    try { fs.unlinkSync(archive); } catch {}
    const bin = path.join(binDir, osName === 'windows' ? 'ngrok.exe' : 'ngrok');
    if (!fs.existsSync(bin)) return { ok: false, error: 'extraction did not produce the ngrok binary' };
    try { fs.chmodSync(bin, 0o755); } catch {}
    return { ok: true, path: bin };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---- MCP config (global app data + per-workspace .conecode/mcp.json) --------
function readMcpConfig(rootPath?: string): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {};
  const global = readJSON<any>('mcp.json', {});
  Object.assign(merged, global.mcpServers || global.servers || {});
  if (rootPath) {
    try {
      const p = path.join(rootPath, '.conecode', 'mcp.json');
      if (fs.existsSync(p)) {
        const ws = JSON.parse(fs.readFileSync(p, 'utf-8'));
        Object.assign(merged, ws.mcpServers || ws.servers || {});
      }
    } catch {}
  }
  return merged;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Lets the preview panel embed the user's running app in a <webview>,
      // sandboxed away from the app's own renderer (see will-attach-webview).
      webviewTag: true,
    },
  });

  const distPath = path.join(__dirname, '../dist/index.html');
  if (fs.existsSync(distPath)) {
    mainWindow.loadFile(distPath);
  } else {
    mainWindow.loadURL('http://localhost:5173');
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  // Keep the privileged application renderer on its own document. A project
  // preview or a model-generated link must not navigate it to remote content.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('context-menu', (_, params) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Cut', role: 'cut', enabled: params.isEditable },
      { label: 'Copy', role: 'copy', enabled: params.selectionText.length > 0 },
      { label: 'Paste', role: 'paste', enabled: params.isEditable },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll' },
    ]);
    menu.popup();
  });

  // The preview <webview> renders whatever the user's project serves, so treat
  // it as untrusted: no Node, no preload, isolated context — it only gets to be
  // a browser tab.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    delete (webPreferences as any).preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });
}

// Links inside the preview that ask for a new window (target=_blank, window.open)
// would otherwise pop a chrome-less Electron window. Send them to the real
// browser instead — that's what the user expects from an embedded preview.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  createWindow();
  registerIPC();
  initProviders();
  // Connect any globally-configured MCP servers in the background.
  mcpManager.reload(readMcpConfig(), getShellEnv()).catch(() => {});
});

app.on('before-quit', () => {
  stopTunnel();
  remoteServer.stop();
  previewManager.stop();
  // Never leave a mouse button held down by a quit mid-drag.
  computerController.panic();
  if (powerSaveBlockerId != null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId);
  }
  powerSaveBlockerId = null;
});
app.on('window-all-closed', () => {
  // On macOS the app keeps running when its window is closed, so DON'T tear down
  // the remote server / tunnel here — doing so killed an active phone session
  // (Cloudflare "error 1033") just because the user closed the window. Cleanup
  // happens in before-quit. On Windows/Linux closing all windows quits the app.
  if (process.platform !== 'darwin') {
    stopTunnel();
    remoteServer.stop();
    app.quit();
  }
});
app.on('activate', () => { if (!mainWindow) createWindow(); });

function initProviders() {
  const providers = providerRepo.findAll();
  for (const p of providers) {
    if (p.enabled) {
      const apiKey = readJSON<Record<string, string>>('apikeys.json', {})[p.id] || '';
      if (apiKey) providerRegistry.register({ ...p, apiKey });
    }
  }
}

function registerIPC() {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());

  ipcMain.handle('notification:show', (_, options: {
    title: string;
    body: string;
    mode: 'never' | 'background' | 'always';
  }) => {
    if (!Notification.isSupported() || options?.mode === 'never') return false;
    if (options?.mode === 'background' && mainWindow?.isFocused()) return false;
    const notification = new Notification({
      title: String(options?.title || 'ConeCode').slice(0, 120),
      body: String(options?.body || '').slice(0, 500),
    });
    notification.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
    notification.show();
    return true;
  });

  ipcMain.handle('power:setPreventSleep', (_, on: boolean) => {
    if (on && powerSaveBlockerId == null) {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!on && powerSaveBlockerId != null) {
      if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
      powerSaveBlockerId = null;
    }
    return powerSaveBlockerId != null;
  });

  ipcMain.handle('provider:list', () => providerRepo.findAll());
  ipcMain.handle('provider:create', (_, config) => {
    const provider = providerRepo.create(config);
    if (config.apiKey) {
      const keys = readJSON<Record<string, string>>('apikeys.json', {});
      keys[provider.id] = config.apiKey;
      writeJSON('apikeys.json', keys);
      providerRegistry.register({ ...provider, apiKey: config.apiKey });
    }
    return provider;
  });
  ipcMain.handle('provider:update', (_, id, config) => {
    const provider = providerRepo.update(id, config);
    if (provider && config.apiKey) {
      const keys = readJSON<Record<string, string>>('apikeys.json', {});
      keys[id] = config.apiKey;
      writeJSON('apikeys.json', keys);
      providerRegistry.register({ ...provider, apiKey: config.apiKey });
    }
    // Disabling a provider → drop its cached models so they stop showing up
    // (they'll be re-fetched fresh if it's re-enabled).
    if (config && config.enabled === false) modelRepo.deleteByProvider(id);
    return provider;
  });
  ipcMain.handle('provider:delete', (_, id) => {
    providerRegistry.unregister(id);
    modelRepo.deleteByProvider(id); // purge cached models so they don't resurrect
    return providerRepo.delete(id);
  });

  ipcMain.handle('model:list', async (_, providerId?) => {
    if (providerId && providerRegistry.hasAdapter(providerId)) {
      try {
        const models = await providerRegistry.getModelsForProvider(providerId);
        // Replace (not merge) the cache so models removed upstream are pruned —
        // otherwise deleted models linger forever (and reach the phone picker).
        modelRepo.replaceForProvider(providerId, models);
        return models;
      } catch (error) {
        console.error(`Failed to fetch models for provider ${providerId}:`, error);
        // Fall through to return local models
      }
    }
    return modelRepo.findAll(providerId);
  });

  // Probe a not-yet-saved provider config for its model list (auto-detect in the
  // add-provider form). Returns the API-derived models incl. context windows.
  ipcMain.handle('model:probe', async (_, cfg: any) => {
    try {
      const now = Date.now();
      const models = await providerRegistry.probeModels({
        id: 'probe-temp',
        name: cfg?.name || 'probe',
        type: (cfg?.type || 'custom') as ProviderConfig['type'],
        baseUrl: cfg?.baseUrl || '',
        apiKey: cfg?.apiKey || '',
        defaultModel: cfg?.defaultModel || '',
        timeout: cfg?.timeout || 30000,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      return { ok: true, models };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('conversation:list', () => conversationRepo.findAll());
  ipcMain.handle('conversation:create', (_, data) => conversationRepo.create(data));
  ipcMain.handle('conversation:update', (_, id, data) => conversationRepo.update(id, data));
  ipcMain.handle('conversation:delete', (_, id) => conversationRepo.delete(id));

  ipcMain.handle('message:list', (_, convId) => messageRepo.findByConversation(convId));
  ipcMain.handle('message:create', (_, data) => messageRepo.create(data));
  ipcMain.handle('message:delete', (_, messageId) => messageRepo.delete(messageId));
  ipcMain.handle('message:editAndTruncate', (_, convId, messageId, content) => messageRepo.editAndTruncate(convId, messageId, content));

  ipcMain.handle('settings:get', () => readJSON('settings.json', {}));
  ipcMain.handle('settings:update', (_, data) => {
    const current = readJSON('settings.json', {});
    writeJSON('settings.json', { ...current, ...data });
    return data;
  });

  ipcMain.handle('favorite:list', () => readJSON<string[]>('favorites.json', []));
  ipcMain.handle('favorite:toggle', (_, modelId) => {
    const favs = readJSON<string[]>('favorites.json', []);
    const idx = favs.indexOf(modelId);
    if (idx >= 0) favs.splice(idx, 1);
    else favs.push(modelId);
    writeJSON('favorites.json', favs);
    return favs;
  });

  ipcMain.handle('recent:list', () => readJSON<string[]>('recent.json', []));
  ipcMain.handle('recent:add', (_, modelId) => {
    let recents = readJSON<string[]>('recent.json', []);
    recents = recents.filter((id) => id !== modelId);
    recents.unshift(modelId);
    recents = recents.slice(0, 10);
    writeJSON('recent.json', recents);
    return recents;
  });

  ipcMain.handle('chat:stream', async (_, { providerId, modelId, messages, reasoningEffort, maxTokens, silent, emitChunks, tools, toolChoice, conversationId }) => {
    const adapter = providerRegistry.getAdapter(providerId);
    const controller = new AbortController();
    // Background calls such as memory extraction never replace the visible
    // run. A compaction call is different: it owns the conversation's abort
    // controller, but its chunks stay out of the normal answer buffer.
    // Streams are tracked PER CONVERSATION: starting a new chat must not
    // abort a run that is still streaming in another conversation.
    const ownsMainStream = !silent;
    // A stream without a conversation id (legacy callers) shares one slot so
    // stop still reaches it; two such callers would replace each other.
    const runKey = (ownsMainStream && conversationId) ? String(conversationId) : '__unkeyed__';
    if (ownsMainStream) {
      mainStreamControllers.get(runKey)?.abort();
      mainStreamControllers.set(runKey, controller);
    }
    const onChunk = (!silent && emitChunks !== false)
      ? (chunk: any) => mainWindow?.webContents.send('chat:chunk', { ...chunk, conversationId: ownsMainStream ? conversationId : undefined })
      : () => {};
    try {
      const result = await adapter.streamMessage(
        { model: modelId, messages, signal: controller.signal, reasoningEffort, maxTokens, tools, toolChoice },
        onChunk,
        controller.signal
      );
      return result;
    } finally {
      if (mainStreamControllers.get(runKey) === controller) mainStreamControllers.delete(runKey);
    }
  });

  ipcMain.handle('chat:stop', (_, conversationId?: string) => {
    if (conversationId != null) {
      mainStreamControllers.get(String(conversationId))?.abort();
      mainStreamControllers.delete(String(conversationId));
    } else {
      for (const controller of mainStreamControllers.values()) controller.abort();
      mainStreamControllers.clear();
    }
    return true;
  });

  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  });

  ipcMain.handle('fs:readFileBase64', async (_, filePath: string) => {
    try {
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
        svg: 'image/svg+xml',
      };
      const mime = mimeMap[ext] || 'application/octet-stream';
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      return true;
    } catch {
      return false;
    }
  });

  // Write binary content (base64) — used by the phone's "upload file" to save an
  // uploaded file to disk.
  ipcMain.handle('fs:writeFileBase64', async (_, filePath: string, base64: string) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:readDir', async (_, dirPath: string) => {
    try {
      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      return items
        .filter((item) => !item.name.startsWith('.'))
        .map((item) => ({
          name: item.name,
          path: path.join(dirPath, item.name),
          isDirectory: item.isDirectory(),
        }))
        .sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      return [];
    }
  });

  ipcMain.handle('fs:exists', async (_, filePath: string) => {
    return fs.existsSync(filePath);
  });

  // New file operations
  ipcMain.handle('fs:createDir', async (_, dirPath: string) => {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:deleteFile', async (_, filePath: string) => {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:deleteDir', async (_, dirPath: string) => {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:rename', async (_, oldPath: string, newPath: string) => {
    try {
      fs.renameSync(oldPath, newPath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:move', async (_, srcPath: string, destPath: string) => {
    try {
      fs.renameSync(srcPath, destPath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:copy', async (_, srcPath: string, destPath: string) => {
    try {
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        fs.cpSync(srcPath, destPath, { recursive: true });
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:stat', async (_, filePath: string) => {
    try {
      const stat = fs.statSync(filePath);
      return {
        size: stat.size,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  });

  // Code search (grep-like): recursively scan text files for a query.
  ipcMain.handle('fs:search', async (_, opts: { query: string; dir?: string; isRegex?: boolean; maxResults?: number }) => {
    const root = opts.dir || process.cwd();
    const max = opts.maxResults || 200;
    const ignore = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'release', 'build', 'out', '.next', '.cache', 'coverage']);
    const results: { file: string; line: number; text: string }[] = [];
    let re: RegExp | null = null;
    if (opts.isRegex) { try { re = new RegExp(opts.query, 'i'); } catch { re = null; } }
    const needle = opts.query.toLowerCase();

    const walk = (dir: string) => {
      if (results.length >= max) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (results.length >= max) break;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (ignore.has(e.name)) continue;
          walk(full);
        } else if (e.isFile()) {
          let stat: fs.Stats;
          try { stat = fs.statSync(full); } catch { continue; }
          if (stat.size > 2 * 1024 * 1024) continue;
          let content: string;
          try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
          if (content.includes('\u0000')) continue; // skip binary
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle);
            if (hit) {
              results.push({ file: full, line: i + 1, text: lines[i].trim().slice(0, 240) });
              if (results.length >= max) break;
            }
          }
        }
      }
    };
    walk(root);
    return results;
  });

  // Glob-like file finder: match file paths against a simple glob pattern.
  ipcMain.handle('fs:glob', async (_, opts: { pattern: string; dir?: string; maxResults?: number }) => {
    const root = opts.dir || process.cwd();
    const max = opts.maxResults || 300;
    const ignore = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'release', 'build', 'out', '.next', '.cache', 'coverage']);
    const results: string[] = [];
    let re: RegExp | null = null;
    try {
      const r = opts.pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
        .replace(/\?/g, '.');
      re = new RegExp(`^${r}$`, 'i');
    } catch { re = null; }

    const walk = (dir: string) => {
      if (results.length >= max) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (results.length >= max) break;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (ignore.has(e.name)) continue;
          walk(full);
        } else if (e.isFile()) {
          const rel = path.relative(root, full);
          if (!re || re.test(rel) || re.test(e.name)) results.push(full);
        }
      }
    };
    walk(root);
    return results;
  });

  // Dialog operations
  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return result.filePaths;
  });

  ipcMain.handle('dialog:saveFile', async (_, defaultPath?: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath,
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  // Command execution. Bounded by a hard timeout: a command that never exits
  // (dev server, watch mode, an interactive prompt waiting for input) would
  // otherwise never resolve this invoke and freeze the whole agent loop — the
  // "executing a command hangs/interrupts the conversation" bug.
  const EXEC_TIMEOUT_MS = 5 * 60 * 1000;
  ipcMain.handle('exec:run', async (_, command: string, cwd?: string, sandbox?: SandboxRequest) => {
    const confinement = resolveSandbox(command, cwd, sandbox);
    return new Promise((resolve) => {
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      // detached → own process group on POSIX, so the timeout can kill the whole
      // tree (e.g. the node server an npm script spawns), not just the shell.
      const child = exec(
        confinement.command,
        // `detached` is forwarded to spawn at runtime but missing from exec's
        // @types/node options, hence the cast. `encoding` pins the string
        // overload so stdout/stderr are typed as text.
        {
          cwd: cwd || process.cwd(),
          maxBuffer: 1024 * 1024 * 50,
          env: getShellEnv(),
          encoding: 'utf-8',
          detached: process.platform !== 'win32',
        } as import('child_process').ExecOptionsWithStringEncoding,
        (error: any, stdout: string, stderr: string) => {
          if (timer) clearTimeout(timer);
          const timeoutNote = timedOut
            ? `[Command killed after ${EXEC_TIMEOUT_MS / 1000}s timeout. If it starts a server/watcher or waits for input, it must not be run through exec — ask the user to run it in a terminal, or add flags that make it exit.]`
            : '';
          // A seatbelt denial reads like a broken command; name it so the agent
          // reports a policy decision instead of flailing at a "permissions bug".
          const denial =
            confinement.sandboxed && !!error && looksLikeSandboxDenial(`${stderr}\n${stdout}`)
              ? `[${SANDBOX_DENIAL_HINT}]`
              : '';
          resolve({
            success: !error && !timedOut,
            stdout: stdout || '',
            // Surface the failure cause even when the shell wrote nothing to
            // stderr (timeout, maxBuffer exceeded, spawn ENOENT, …).
            stderr: [stderr || '', timeoutNote || (error && !stderr ? error.message : ''), denial]
              .filter(Boolean).join('\n'),
            exitCode: timedOut ? 124 : (error?.code ?? 0),
            sandboxed: confinement.sandboxed,
          });
        }
      );
      // Close stdin so interactive prompts fail fast with EOF instead of
      // blocking until the timeout.
      child.stdin?.end();
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch {}
        }
      }, EXEC_TIMEOUT_MS);
    });
  });

  ipcMain.handle('exec:spawn', async (_, command: string, args: string[], cwd?: string) => {
    return new Promise((resolve) => {
      const proc = spawn(command, args, { cwd: cwd || process.cwd(), env: getShellEnv() });
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      
      proc.on('close', (code) => {
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code || 0,
        });
      });
      
      proc.on('error', (err) => {
        resolve({
          success: false,
          stdout: '',
          stderr: err.message,
          exitCode: 1,
        });
      });
    });
  });

  // App operations
  ipcMain.handle('app:open', async (_, appName: string) => {
    try {
      await shell.openExternal(appName);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('app:openPath', async (_, path: string) => {
    try {
      await shell.openPath(path);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('app:getSystemInfo', async () => {
    return {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      uptime: os.uptime(),
      // Where autopilot creates new projects without asking for a folder.
      homedir: os.homedir(),
    };
  });

  // ---- Git -------------------------------------------------------------
  ipcMain.handle('git:info', async (_, cwd?: string) => {
    const dir = cwd || process.cwd();
    const isRepo = (await runGit(['rev-parse', '--is-inside-work-tree'], dir)).stdout.trim() === 'true';
    if (!isRepo) return { isRepo: false, branch: null, dirty: 0 };
    let branch = (await runGit(['branch', '--show-current'], dir)).stdout.trim();
    if (!branch) branch = (await runGit(['rev-parse', '--short', 'HEAD'], dir)).stdout.trim() || 'HEAD';
    const status = await runGit(['status', '--porcelain'], dir);
    const dirty = status.stdout.split('\n').filter((l) => l.trim()).length;
    return { isRepo: true, branch, dirty };
  });

  ipcMain.handle('git:status', async (_, cwd?: string) => {
    const r = await runGit(['status'], cwd || process.cwd());
    return r.code === 0 ? r.stdout : (r.stderr || `git status failed (exit ${r.code})`);
  });

  ipcMain.handle('git:diff', async (_, cwd?: string, file?: string) => {
    const args = ['diff'];
    if (file) args.push('--', file);
    const r = await runGit(args, cwd || process.cwd());
    return r.code === 0 ? r.stdout : (r.stderr || `git diff failed (exit ${r.code})`);
  });

  ipcMain.handle('git:branches', async (_, cwd?: string) => {
    const dir = cwd || process.cwd();
    const result = await runGit(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
      dir,
    );
    if (result.code !== 0) return [];
    return Array.from(new Set(result.stdout.split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('/HEAD'))));
  });

  ipcMain.handle('git:review', async (_event, cwd: string, options: {
    scope: 'uncommitted' | 'base' | 'commit';
    target?: string;
  }) => {
    const info = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    if (info.code !== 0 || info.stdout.trim() !== 'true') {
      return { ok: false, error: 'The selected project is not a Git repository.' };
    }

    const status = await runGit(['status', '--short'], cwd);
    const target = options?.target?.trim() || '';
    if (target.startsWith('-') || target.includes('\0') || target.length > 240) {
      return { ok: false, error: 'Invalid Git revision.' };
    }

    let diff: { code: number; stdout: string; stderr: string };
    if (options.scope === 'base') {
      if (!target) return { ok: false, error: 'Choose a base branch.' };
      const mergeBase = await runGit(['merge-base', 'HEAD', target], cwd);
      if (mergeBase.code !== 0) return { ok: false, error: mergeBase.stderr || `Could not compare with ${target}.` };
      diff = await runGit(['diff', '--no-ext-diff', `${mergeBase.stdout.trim()}..HEAD`], cwd);
    } else if (options.scope === 'commit') {
      if (!target) return { ok: false, error: 'Enter a commit revision.' };
      diff = await runGit(['show', '--format=fuller', '--no-ext-diff', target], cwd);
    } else {
      // HEAD includes staged and unstaged changes. Untracked paths are present in
      // status; the read-only reviewer can inspect their contents through tools.
      diff = await runGit(['diff', '--no-ext-diff', 'HEAD'], cwd);
    }

    if (diff.code !== 0) return { ok: false, error: diff.stderr || 'Could not read the Git diff.' };
    return {
      ok: true,
      status: status.stdout,
      diff: diff.stdout,
      scope: options.scope,
      target: target || null,
    };
  });

  ipcMain.handle('worktree:list', async (_, cwd: string) => {
    const rootResult = await runGit(['rev-parse', '--show-toplevel'], cwd);
    if (rootResult.code !== 0) return { ok: false, error: 'The selected project is not a Git repository.', worktrees: [] };
    const currentPath = rootResult.stdout.trim();
    const result = await runGit(['worktree', 'list', '--porcelain'], currentPath);
    if (result.code !== 0) return { ok: false, error: result.stderr || 'Could not list worktrees.', worktrees: [] };
    const managedRoot = path.join(app.getPath('userData'), 'worktrees');
    // Git lists the primary checkout first. rev-parse only returns the current
    // checkout, which would incorrectly label a managed worktree as "main".
    const mainPath = result.stdout.match(/^worktree (.+)$/m)?.[1]?.trim() || currentPath;
    const worktrees = parseWorktreeList(result.stdout, mainPath, managedRoot);
    for (const item of worktrees) {
      const status = await runGit(['status', '--porcelain'], item.path);
      (item as any).dirty = status.code === 0
        ? status.stdout.split('\n').filter((line) => line.trim()).length
        : 0;
    }
    return { ok: true, mainPath, currentPath, managedRoot, worktrees };
  });

  ipcMain.handle('worktree:create', async (_, cwd: string, options: { ref?: string; name?: string }) => {
    const rootResult = await runGit(['rev-parse', '--show-toplevel'], cwd);
    if (rootResult.code !== 0) return { ok: false, error: 'The selected project is not a Git repository.' };
    const repoRoot = rootResult.stdout.trim();
    const ref = options?.ref?.trim() || 'HEAD';
    if (!validGitRevision(ref)) return { ok: false, error: 'Invalid starting branch or revision.' };

    const requestedName = (options?.name || path.basename(repoRoot))
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'task';
    const managedRoot = path.join(app.getPath('userData'), 'worktrees');
    fs.mkdirSync(managedRoot, { recursive: true });
    const destination = path.join(managedRoot, `${requestedName}-${Date.now().toString(36)}`);
    const result = await runGit(['worktree', 'add', '--detach', destination, ref], repoRoot);
    if (result.code !== 0) {
      try { if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true }); } catch {}
      return { ok: false, error: result.stderr || `Could not create a worktree from ${ref}.` };
    }
    return { ok: true, path: destination, ref };
  });

  ipcMain.handle('worktree:remove', async (_, cwd: string, worktreePath: string) => {
    const rootResult = await runGit(['rev-parse', '--show-toplevel'], cwd);
    if (rootResult.code !== 0) return { ok: false, error: 'The selected project is not a Git repository.' };
    const repoRoot = rootResult.stdout.trim();
    const managedRoot = path.join(app.getPath('userData'), 'worktrees');
    const resolved = path.resolve(worktreePath);
    const relative = path.relative(managedRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, error: 'Only ConeCode-managed worktrees can be removed here.' };
    }
    const status = await runGit(['status', '--porcelain'], resolved);
    if (status.code === 0 && status.stdout.trim()) {
      return { ok: false, error: 'This worktree has uncommitted changes. Commit or move them before removing it.' };
    }
    const result = await runGit(['worktree', 'remove', resolved], repoRoot);
    if (result.code !== 0) return { ok: false, error: result.stderr || 'Could not remove the worktree.' };
    await runGit(['worktree', 'prune'], repoRoot);
    return { ok: true };
  });

  // ---- Web tools -------------------------------------------------------
  ipcMain.handle('net:fetch', (_, url: string) => netFetch(url));
  ipcMain.handle('net:search', (_, query: string) => netSearch(query));
  ipcMain.handle('net:download', (_, url: string, dest: string) => netDownload(url, dest));

  // ---- Skills (the plugin library) -------------------------------------
  // Global skills live in ~/.conecode/skills; project skills in
  // <root>/.conecode/skills and shadow a global one of the same id.
  const globalSkillsDir = () => path.join(os.homedir(), '.conecode', 'skills');
  const projectSkillsDir = (root: string) => path.join(root, '.conecode', 'skills');

  function readSkillsFrom(dir: string, scope: 'global' | 'project') {
    const out: any[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out; // not created yet — an empty library, not an error
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, SKILL_FILE);
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const skill = parseSkill(raw, { id: entry.name, scope, path: path.join(dir, entry.name) });
        if (skill) out.push(skill);
      } catch {
        // A malformed or unreadable skill is skipped, never fatal.
      }
    }
    return out;
  }

  ipcMain.handle('skill:list', (_, rootPath?: string) => ({
    global: readSkillsFrom(globalSkillsDir(), 'global'),
    project: rootPath ? readSkillsFrom(projectSkillsDir(rootPath), 'project') : [],
  }));

  ipcMain.handle('skill:install', (_, opts: { id: string; content: string; scope: 'global' | 'project'; rootPath?: string }) => {
    try {
      // The id becomes a directory name, so it must never escape the library.
      if (!isSafeSkillId(opts.id)) return { ok: false, error: 'invalid skill id' };
      const base = opts.scope === 'project'
        ? (opts.rootPath ? projectSkillsDir(opts.rootPath) : null)
        : globalSkillsDir();
      if (!base) return { ok: false, error: 'no project open' };
      const dir = path.join(base, opts.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, SKILL_FILE), opts.content, 'utf-8');
      return { ok: true, path: dir };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('skill:remove', (_, opts: { id: string; scope: 'global' | 'project'; rootPath?: string }) => {
    try {
      if (!isSafeSkillId(opts.id)) return { ok: false, error: 'invalid skill id' };
      const base = opts.scope === 'project'
        ? (opts.rootPath ? projectSkillsDir(opts.rootPath) : null)
        : globalSkillsDir();
      if (!base) return { ok: false, error: 'no project open' };
      fs.rmSync(path.join(base, opts.id), { recursive: true, force: true });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // ---- Long-term memory (what the agent has learned about the user) ------
  ipcMain.handle('memory:list', () => readJSON<any[]>('memory.json', []));
  ipcMain.handle('memory:save', (_, entries: any[]) => {
    writeJSON('memory.json', Array.isArray(entries) ? entries : []);
    return true;
  });

  // ---- MCP -------------------------------------------------------------
  ipcMain.handle('mcp:list', () => mcpManager.listTools());
  ipcMain.handle('mcp:call', (_, server: string, tool: string, args: any) => mcpManager.callTool(server, tool, args));
  ipcMain.handle('mcp:reload', async (_, rootPath?: string) => {
    await mcpManager.reload(readMcpConfig(rootPath), getShellEnv());
    return mcpManager.listTools();
  });
  ipcMain.handle('mcp:getConfig', () => readJSON('mcp.json', { mcpServers: {} }));
  ipcMain.handle('mcp:setConfig', async (_, cfg: any) => {
    writeJSON('mcp.json', cfg);
    await mcpManager.reload(readMcpConfig(), getShellEnv());
    return mcpManager.listTools();
  });

  // ---- Terminal (interactive shells, keyed by tab id) ---------------------
  ipcMain.handle('terminal:spawn', (_, id: string, cwd?: string) => {
    const existing = terminals.get(id);
    if (existing) {
      existing.kill();
      terminals.delete(id);
    }
    const shellBin = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/zsh');
    // Non-interactive: an interactive (-i) shell on a non-TTY pipe drives the
    // line editor (ZLE), which spews carriage returns and redrawn prompts and
    // buries real output. A plain piped shell reads stdin line-by-line and runs
    // each command cleanly; the resolved login PATH is supplied via getShellEnv.
    const args: string[] = [];
    // TERM=xterm-256color + FORCE_COLOR/CLICOLOR_FORCE make CLI tools (ls, grep,
    // git, npm…) emit ANSI color even though stdout is a pipe (not a TTY); the
    // renderer parses those escape codes into colored spans.
    const proc = spawn(shellBin, args, {
      cwd: cwd || os.homedir(),
      env: {
        ...getShellEnv(),
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
        CLICOLOR: '1',
        CLICOLOR_FORCE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (data: Buffer) => {
      mainWindow?.webContents.send('terminal:data', { id, data: data.toString() });
    });
    proc.stderr?.on('data', (data: Buffer) => {
      mainWindow?.webContents.send('terminal:data', { id, data: data.toString() });
    });
    proc.on('close', (code: number | null) => {
      mainWindow?.webContents.send('terminal:exit', { id, code: code ?? 0 });
      terminals.delete(id);
    });
    terminals.set(id, proc);
    return true;
  });

  ipcMain.handle('terminal:write', (_, id: string, data: string) => {
    terminals.get(id)?.stdin?.write(data);
    return true;
  });

  ipcMain.handle('terminal:kill', (_, id: string) => {
    const proc = terminals.get(id);
    proc?.kill();
    terminals.delete(id);
    return true;
  });

  // ---- Remote control (phone) ------------------------------------------
  ipcMain.handle('remote:start', async (_, opts?: { tunnel?: boolean; tunnelConfig?: any }) => {
    const { port, token } = await remoteServer.start(app.getPath('userData'));
    // Forward phone commands + connection-count changes to the renderer once.
    if (!remoteWired) {
      remoteWired = true;
      remoteServer.on('command', (cmd) => mainWindow?.webContents.send('remote:command', cmd));
      remoteServer.on('clients', (n) => mainWindow?.webContents.send('remote:clients', n));
    }
    if (opts?.tunnel && !remoteTunnelUrl) {
      const r = await startTunnel(port, getShellEnv(), opts.tunnelConfig || {});
      if (r.url) remoteTunnelUrl = `${r.url}/?t=${token}`;
      else return { ...remoteStatus(), tunnelError: r.error || 'failed', tunnelDetail: r.detail };
    }
    return remoteStatus();
  });

  ipcMain.handle('remote:stop', () => {
    stopTunnel();
    remoteTunnelUrl = null;
    remoteServer.stop();
    return remoteStatus();
  });

  ipcMain.handle('remote:status', () => remoteStatus());

  // Renderer (source of truth) pushes a state frame → fan out to every phone.
  ipcMain.handle('remote:publish', (_, frame: any) => {
    remoteServer.publish(frame);
    return true;
  });

  // Optional connection password (extra login factor). Persisted by the renderer.
  ipcMain.handle('remote:setPassword', (_, pw: string | null) => {
    remoteServer.setPassword(pw);
    return remoteStatus();
  });

  // One-click ngrok install (downloads the official agent into userData/bin).
  ipcMain.handle('remote:installNgrok', () => installNgrok());

  // Forcibly disconnect a connected phone.
  ipcMain.handle('remote:kick', (_, id: string) => {
    remoteServer.kick(id);
    return remoteStatus();
  });

  // ---- Live preview (built-in browser) ---------------------------------
  // Wire the manager's streams to the renderer once; the panel subscribes on
  // mount and can come and go without the dev server noticing.
  previewManager.setEnv(getShellEnv());
  if (!previewWired) {
    previewWired = true;
    previewManager.on('status', (st) => mainWindow?.webContents.send('preview:status', st));
    previewManager.on('log', (entry) => mainWindow?.webContents.send('preview:log', entry));
    previewManager.on('reload', () => mainWindow?.webContents.send('preview:reload'));
  }

  ipcMain.handle('preview:detect', (_, cwd: string) => detectPreview(cwd));
  ipcMain.handle('preview:start', (_, opts: { cwd: string; command?: string | null }) => previewManager.start(opts));
  ipcMain.handle('preview:stop', () => previewManager.stop());
  ipcMain.handle('preview:status', () => previewManager.getStatus());
  ipcMain.handle('preview:openExternal', async (_, url: string) => {
    if (!/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  // ---- Computer control (agent drives the real screen) ------------------
  // Every one of these is a no-op until the user flips the master switch in the
  // panel; the controller itself refuses otherwise, so a compromised renderer
  // can't turn it on by calling `act` directly.
  ipcMain.handle('computer:status', () => computerController.status());
  ipcMain.handle('computer:setEnabled', (_, on: boolean) => {
    computerController.setEnabled(!!on);
    return computerController.status();
  });
  ipcMain.handle('computer:requestPermissions', () => computerController.requestPermissions());
  ipcMain.handle('computer:screenshot', () => computerController.screenshot());
  ipcMain.handle('computer:act', (_, req: any) => computerController.act(req));
  ipcMain.handle('computer:panic', async () => {
    await computerController.panic();
    return computerController.status();
  });
}
