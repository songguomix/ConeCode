import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent, Rectangle } from 'electron';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describeAction, validateComputerRequest, type ComputerFrame, type ComputerRequest } from '../../src/core/computer/computer';
import { COMPUTER_PREVIEW_CHANNELS as CHANNELS, COMPUTER_PREVIEW_HASH, type ComputerPreviewSnapshot, type ComputerPreviewStatus, type ComputerPreviewAppearance } from '../../src/core/computer/preview';

interface Options {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  getMainWindow(): BrowserWindow | null;
  getStatus(): ComputerPreviewStatus;
  getWorkArea(): Rectangle;
  preloadPath: string;
  indexFile: string;
  devServerUrl?: string;
}

interface CaptureToken { generation: number; requestSeq: number }
type CaptureResult = ComputerFrame | { error: string; needsPermission?: 'screenRecording' };

/** Actual computer IPC outcomes, shared in memory with a least-privilege viewer. */
export class ComputerPreviewWindow {
  private window: BrowserWindow | null = null;
  private loading?: Promise<void>;
  private generation = 0;
  private captureSeq = 0;
  private activitySeq = 0;
  private state: ComputerPreviewSnapshot = {
    revision: 0, updatedAt: Date.now(),
    status: { platform: process.platform, enabled: false, supported: false, accessibility: false, screenRecording: false, geometry: null, target: null, targetRevision: 0, frameId: null },
    shot: null, activity: [], inFlight: 0,
  };

  constructor(private readonly options: Options) {}

  assertMain(event: IpcMainInvokeEvent): void {
    const main = this.options.getMainWindow();
    if (!main || main.isDestroyed() || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) {
      throw new Error('Only the main application window may use computer control.');
    }
  }

  private assertPreview(event: IpcMainInvokeEvent): void {
    if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame) {
      throw new Error('Only the computer preview window may use this interface.');
    }
  }

  register(ipc: Pick<IpcMain, 'handle'>): void {
    ipc.handle(CHANNELS.open, async (event, appearance?: ComputerPreviewAppearance) => {
      this.assertMain(event);
      try { await this.open(appearance); return { ok: true }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    ipc.handle(CHANNELS.getState, (event) => { this.assertPreview(event); this.statusChanged(); return this.snapshot(); });
    ipc.handle(CHANNELS.close, (event) => { this.assertMain(event); this.close(); });
    ipc.handle(CHANNELS.getVisibility, (event) => { this.assertMain(event); return this.visibility(); });
  }

  async open(appearance?: ComputerPreviewAppearance): Promise<void> {
    if (appearance !== undefined) {
      if (!appearance || typeof appearance !== 'object' || Object.keys(appearance).some((key) => !['locale', 'theme'].includes(key)) ||
        !['en', 'zh', 'zhHant', 'ja'].includes(appearance.locale) || !['light', 'dark'].includes(appearance.theme)) {
        throw new Error('Preview appearance requires a supported locale and light/dark theme only.');
      }
      this.state.appearance = { locale: appearance.locale, theme: appearance.theme };
    }
    this.statusChanged();
    if (this.window && !this.window.isDestroyed()) {
      if (this.loading) await this.loading;
      if (this.window && !this.window.isDestroyed()) { if (this.window.isMinimized()) this.window.restore(); this.window.showInactive(); this.publishVisibility(); }
      return;
    }
    let devUrl: URL | undefined;
    if (this.options.devServerUrl) {
      devUrl = new URL(this.options.devServerUrl);
      if (devUrl.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(devUrl.hostname) || devUrl.username || devUrl.password) {
        throw new Error('Computer preview only loads the packaged app or a local development server.');
      }
      devUrl.hash = COMPUTER_PREVIEW_HASH;
    } else if (!existsSync(this.options.indexFile)) {
      throw new Error('Build the ConeCode application before opening its computer preview.');
    }
    const area = this.options.getWorkArea();
    const geometry = this.state.shot?.geometry ?? this.state.status.geometry;
    const candidateRatio = geometry ? geometry.captureWidth / geometry.captureHeight : 1.6;
    const ratio = Number.isFinite(candidateRatio) && candidateRatio > 0 ? candidateRatio : 1.6;
    const width = Math.max(1, Math.round(Math.min(390, area.width, area.height * ratio)));
    const height = Math.max(1, Math.round(width / ratio));
    const win = this.options.createWindow({
      x: Math.max(area.x, area.x + area.width - width - 24), y: Math.max(area.y, area.y + area.height - height - 24),
      width, height, minWidth: Math.min(240, width), minHeight: Math.min(120, height),
      frame: false, movable: true, resizable: true, minimizable: true, maximizable: false,
      fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, show: false,
      title: 'ConeCode Computer Preview', backgroundColor: '#00000000', transparent: true, hasShadow: false, roundedCorners: false,
      webPreferences: {
        preload: this.options.preloadPath, nodeIntegration: false, contextIsolation: true,
        sandbox: true, webviewTag: false, backgroundThrottling: false, partition: 'computer-preview',
      },
    });
    this.window = win;
    win.setAlwaysOnTop(true, 'floating');
    win.setAspectRatio(ratio);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // The preview must never itself be an input or capture target.
    win.setContentProtection(true);
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-frame-navigate', (event) => event.preventDefault());
    win.webContents.on('will-redirect', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    const root = path.dirname(path.resolve(this.options.indexFile));
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try {
        const url = new URL(details.url);
        if (url.protocol === 'data:' || url.protocol === 'blob:') allowed = true;
        else if (devUrl) {
          if (url.protocol === 'ws:') url.protocol = 'http:';
          allowed = url.origin === devUrl.origin;
        } else if (url.protocol === 'file:') {
          const file = path.resolve(fileURLToPath(url));
          allowed = file === path.resolve(this.options.indexFile) || file.startsWith(root + path.sep);
        }
      } catch { /* reject malformed and unknown protocols */ }
      callback({ cancel: !allowed });
    });
    const visibilityChanged = () => this.publishVisibility();
    win.on('show', visibilityChanged);
    win.on('hide', visibilityChanged);
    win.on('minimize', visibilityChanged);
    win.on('restore', visibilityChanged);
    win.on('closed', () => { if (this.window === win) { this.window = null; this.loading = undefined; this.publishVisibility(); } });
    win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.destroy(); });
    const load = devUrl ? win.loadURL(devUrl.href) : win.loadFile(this.options.indexFile, { hash: COMPUTER_PREVIEW_HASH.slice(1) });
    this.loading = load;
    try {
      await load;
      if (this.window === win && !win.isDestroyed()) { this.publish(); win.showInactive(); this.publishVisibility(); }
    } catch (error) {
      if (!win.isDestroyed()) win.destroy();
      throw error;
    } finally { if (this.window === win) this.loading = undefined; }
  }

  snapshot(): ComputerPreviewSnapshot { return structuredClone(this.state); }

  visibility(): { visible: boolean } {
    return { visible: !!this.window && !this.window.isDestroyed() && this.window.isVisible() && !this.window.isMinimized() };
  }

  close(): void { if (this.window && !this.window.isDestroyed()) this.window.close(); }

  statusChanged(forceClear = false): void {
    const status = this.options.getStatus();
    if (forceClear || status.targetRevision !== this.state.status.targetRevision || status.enabled !== this.state.status.enabled) {
      this.generation += 1;
      this.state.shot = null;
    } else if (this.state.shot && status.frameId !== this.state.shot.frameId) {
      this.state.shot = null;
    }
    this.state.status = status;
    const main = this.options.getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send('computer:status-changed', { ...status });
    this.publish();
  }

  clearShot(): void {
    this.generation += 1;
    this.state.shot = null;
    this.publish();
  }

  beginOperation(): number {
    this.state.inFlight += 1;
    this.publish();
    return this.generation;
  }

  beginScreenshot(): CaptureToken {
    this.statusChanged();
    this.beginOperation();
    return { generation: this.generation, requestSeq: ++this.captureSeq };
  }

  /** Guard both the viewer and the result returned to the agent/model. */
  async capture(screenshot: () => Promise<CaptureResult>): Promise<CaptureResult> {
    if (!this.options.getStatus().enabled) return { error: 'Computer control is switched off. No screenshot was captured.' };
    const token = this.beginScreenshot();
    try {
      const result = await screenshot();
      const accepted = this.endScreenshot(result, token);
      return 'dataUrl' in result && !accepted ? { error: 'Screenshot discarded: control changed or a newer capture was requested.' } : result;
    } catch (error) {
      this.endScreenshot({ error: String(error) }, token);
      throw error;
    }
  }

  endScreenshot(result: CaptureResult, token: CaptureToken): boolean {
    this.state.inFlight = Math.max(0, this.state.inFlight - 1);
    // Disabling/re-enabling or emergency stop fences captures started earlier.
    const status = this.options.getStatus();
    const accepted = token.generation === this.generation && token.requestSeq === this.captureSeq
      && status.enabled && 'dataUrl' in result && status.frameId === result.frameId
      && status.target?.id === result.target.id && /^data:image\/(?:png|jpe?g|webp);base64,/.test(result.dataUrl);
    if (accepted && 'dataUrl' in result) {
      this.state.shot = { ...result, capturedAt: Date.now() };
      const area = this.options.getWorkArea();
      const ratio = result.geometry.captureWidth / result.geometry.captureHeight;
      const width = Math.max(1, Math.round(Math.min(390, area.width, area.height * ratio)));
      const win = this.window;
      if (win && !win.isDestroyed()) {
        win.setAspectRatio(ratio);
        win.setSize(width, Math.max(1, Math.round(width / ratio)));
      }
    }
    this.statusChanged();
    return accepted;
  }

  endAction(req: ComputerRequest, result: { ok: boolean; message: string }): void {
    this.state.inFlight = Math.max(0, this.state.inFlight - 1);
    let description = 'Computer action';
    try {
      if (!validateComputerRequest(req)) description = req.action === 'type'
        ? `Type ${[...(req.text ?? '')].length} characters` : describeAction(req);
    } catch { /* malformed requests are recorded without echoing their input */ }
    this.state.activity = [...this.state.activity, {
      id: ++this.activitySeq, at: Date.now(), description, ok: result.ok,
      ...(!result.ok ? { detail: req?.action === 'type' ? 'Text input failed; see the main application for details.' : String(result.message).slice(0, 500) } : {}),
    }].slice(-100);
    this.statusChanged();
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.loading = undefined;
    this.clearShot();
    this.publishVisibility();
  }

  private publish(): void {
    this.state.revision += 1;
    this.state.updatedAt = Date.now();
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(CHANNELS.state, this.snapshot());
  }

  private publishVisibility(): void {
    const main = this.options.getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send(CHANNELS.visibility, this.visibility());
  }
}
