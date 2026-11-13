import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, net, session, shell } from 'electron';
import {
  checkForUpdate,
  isAllowedDownloadUrl,
  type UpdateDownloadProgress,
  type UpdateDownloadStart,
} from '../../src/core/updates/updateClient';

/**
 * Update plumbing for ConeCode.
 *
 * Metadata comes from the agibase `/update` endpoint (checked in the main
 * process so the renderer never needs network permissions or the user's IP
 * address in a page context). Installer downloads go through Chromium's own
 * download manager, which gives us redirect handling plus byte progress.
 */

let downloadBridgeAttached = false;
let pendingDownload: { url: string; fileName: string; expiresAt: number } | null = null;
let activeDownload = false;
let lastDownloadPath: string | null = null;

const CHECK_HARD_TIMEOUT_MS = 20_000;

/**
 * `net.fetch` goes through Chromium's network stack, so the check honours the
 * user's system proxy and certificate store (plain Node fetch does not). We
 * still race a hard timeout because that stack does not always honour signals.
 */
async function fetchUpdate(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Update check timed out');
      error.name = 'AbortError';
      reject(error);
    }, CHECK_HARD_TIMEOUT_MS);
  });
  try {
    return (await Promise.race([net.fetch(input as string, init), hardStop])) as Response;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function safeFileName(candidate: string | null, url: string): string {
  const fromUrl = (() => {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    } catch {
      return '';
    }
  })();
  const raw = (candidate || fromUrl || 'ConeCode-update').trim();
  // Strip any path separators / control characters before writing to disk.
  const cleaned = path.basename(raw).replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '');
  return cleaned || 'ConeCode-update';
}

function uniqueSavePath(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const stem = ext ? fileName.slice(0, -ext.length) : fileName;
  let target = path.join(dir, fileName);
  let index = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${stem} (${index})${ext}`);
    index += 1;
  }
  return target;
}

function canonicalDownloadUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = ''; // Fragments are not sent with the HTTP request.
    return url.href;
  } catch {
    return null;
  }
}

function attachDownloadBridge(downloads: Electron.Session): void {
  if (downloadBridgeAttached) return;
  downloadBridgeAttached = true;

  downloads.on('will-download', (event, item) => {
    const pending = pendingDownload;
    const initialUrl = canonicalDownloadUrl(item.getURLChain()[0] ?? item.getURL());
    if (!pending || Date.now() >= pending.expiresAt || initialUrl !== pending.url) {
      // This session is reserved for updates. Reject late or unexpected items
      // without consuming an outstanding request for the expected installer.
      event.preventDefault();
      return;
    }
    pendingDownload = null;
    activeDownload = true;

    try {
      item.setSavePath(uniqueSavePath(app.getPath('downloads'), pending.fileName));
    } catch {
      // Fall back to Chromium's own save location if the path is unusable.
    }

    const total = item.getTotalBytes();
    broadcast('update:download-progress', { state: 'downloading', received: 0, total } satisfies UpdateDownloadProgress);

    item.on('updated', (_evt, state) => {
      if (state === 'interrupted') {
        broadcast('update:download-progress', { state: 'error', message: 'interrupted' } satisfies UpdateDownloadProgress);
        return;
      }
      broadcast('update:download-progress', {
        state: 'downloading',
        received: item.getReceivedBytes(),
        total: item.getTotalBytes() || total,
      } satisfies UpdateDownloadProgress);
    });

    item.once('done', (_evt, state) => {
      activeDownload = false;
      if (state === 'completed') {
        const filePath = item.getSavePath();
        lastDownloadPath = filePath;
        broadcast('update:download-progress', {
          state: 'completed',
          received: item.getReceivedBytes(),
          total: item.getTotalBytes() || total,
          path: filePath,
        } satisfies UpdateDownloadProgress);
      } else {
        broadcast('update:download-progress', {
          state: 'error',
          message: state || 'failed',
        } satisfies UpdateDownloadProgress);
      }
    });
  });
}

export function registerUpdateIpc(): void {
  // No `persist:` prefix: installer downloads do not share browsing state or
  // the download events from file exports and plugin installs.
  const downloads = session.fromPartition('conecode-updates', { cache: false });
  attachDownloadBridge(downloads);

  ipcMain.handle('update:check', async () =>
    checkForUpdate({
      baseUrl: process.env.CONECODE_UPDATE_BASE_URL || undefined,
      currentVersion: app.getVersion(),
      platform: process.platform,
      userAgent: `ConeCode/${app.getVersion()} (${process.platform}-${process.arch})`,
      fetchImpl: fetchUpdate as unknown as typeof fetch,
    }),
  );

  ipcMain.handle(
    'update:download',
    async (_, url: string, fileName?: string): Promise<UpdateDownloadStart> => {
      const initialUrl = typeof url === 'string' ? canonicalDownloadUrl(url) : null;
      if (!initialUrl || !isAllowedDownloadUrl(initialUrl)) return { ok: false, error: 'blocked' };
      if (activeDownload || (pendingDownload && Date.now() < pendingDownload.expiresAt)) return { ok: false, error: 'busy' };

      try {
        fs.mkdirSync(app.getPath('downloads'), { recursive: true });
      } catch {
        // The default download folder normally exists; Chromium will surface an
        // error through `done` if it truly cannot write there.
      }

      pendingDownload = { url: initialUrl, fileName: safeFileName(fileName || null, initialUrl), expiresAt: Date.now() + 60_000 };
      try {
        downloads.downloadURL(initialUrl);
      } catch {
        pendingDownload = null;
        return { ok: false, error: 'failed' };
      }
      return { ok: true };
    },
  );

  ipcMain.handle('update:reveal', (_, filePath: string) => {
    // Only reveal the installer we downloaded in this session; never let the
    // renderer point the file manager at an arbitrary path.
    const target = lastDownloadPath;
    if (!target || (typeof filePath === 'string' && filePath && filePath !== target)) return false;
    if (!path.isAbsolute(target) || !fs.existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });
}
