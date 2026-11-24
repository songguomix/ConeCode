import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent, Rectangle } from 'electron';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describeAction, toCapturePoint, toLogicalPoint, validateComputerRequest, type ComputerFrame, type ComputerRequest } from '../../src/core/computer/computer';
import {
  COMPUTER_PREVIEW_CHANNELS as CHANNELS, COMPUTER_PREVIEW_HASH,
  type ComputerPreviewAppearance, type ComputerPreviewCommandResult, type ComputerPreviewPointer,
  type ComputerPreviewSnapshot, type ComputerPreviewStatus, type ComputerPreviewUpdate,
} from '../../src/core/computer/preview';
import type { ComputerActionResult } from './controller';

interface Options {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  getMainWindow(): BrowserWindow | null;
  getStatus(): ComputerPreviewStatus;
  getWorkArea(): Rectangle;
  act(req: ComputerRequest): Promise<ComputerActionResult>;
  screenshot(targetRevision?: number): Promise<CaptureResult>;
  preloadPath: string;
  indexFile: string;
  devServerUrl?: string;
}

interface CaptureToken { generation: number; requestSeq: number; targetRevision: number }
type CaptureResult = ComputerFrame | { error: string; needsPermission?: 'screenRecording' };

const windowsPointerActions = new Set<ComputerRequest['action']>([
  'mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'scroll',
]);

function previewInput(input: unknown, platform: string): ComputerRequest | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const req = input as ComputerRequest;
  const fields = ['action', 'frameId'];
  switch (req.action) {
    case 'type':
      fields.push('text');
      break;
    case 'scroll':
      if (platform !== 'win32' || typeof req.scroll_amount !== 'number') return null;
      fields.push('coordinate', 'scroll_direction', 'scroll_amount');
      break;
    case 'right_click':
      if (platform !== 'win32') return null;
      fields.push('coordinate');
      break;
    case 'left_click':
      fields.push('coordinate');
      break;
    default:
      return null;
  }
  if (typeof req.frameId !== 'string' || Object.keys(req).some((field) => !fields.includes(field))) return null;
  if (fields.includes('coordinate') && !req.coordinate) return null;
  return validateComputerRequest(req) ? null : req;
}

/** Scoped input and observed computer state for the isolated preview. */
export class ComputerPreviewWindow {
  private window: BrowserWindow | null = null;
  private loading?: Promise<void>;
  private generation = 0;
  private captureSeq = 0;
  private activeCapture?: { token: CaptureToken; result: Promise<CaptureResult> };
  private activitySeq = 0;
  private pointerSeq = 0;
  private aspectRatio = 1.6;
  private publishedFrameId: string | null = null;
  private state: ComputerPreviewSnapshot = {
    revision: 0, updatedAt: Date.now(),
    status: { platform: process.platform, enabled: false, supported: false, accessibility: false, screenRecording: false, geometry: null, target: null, targetRevision: 0, frameId: null },
    shot: null, pointer: null, activity: [], inFlight: 0,
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
    ipc.handle(CHANNELS.getState, (event) => {
      this.assertPreview(event);
      this.syncStatus(false, this.options.getStatus());
      this.advanceRevision();
      this.publishedFrameId = this.state.shot?.frameId ?? null;
      return this.snapshot();
    });
    ipc.handle(CHANNELS.act, (event, input: unknown) => { this.assertPreview(event); return this.manualAction(input); });
    ipc.handle(CHANNELS.refresh, (event, revision: unknown) => { this.assertPreview(event); return this.refresh(revision); });
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
    this.aspectRatio = ratio;
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
    this.publishedFrameId = null;
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

  statusChanged(forceClear = false, status = this.options.getStatus()): void {
    this.syncStatus(forceClear, status);
    this.publish();
  }

  private syncStatus(forceClear: boolean, status: ComputerPreviewStatus): void {
    if (forceClear || status.targetRevision !== this.state.status.targetRevision || status.enabled !== this.state.status.enabled) {
      this.generation += 1;
      this.state.shot = null;
      this.state.pointer = null;
    } else if (this.state.shot && status.frameId !== this.state.shot.frameId) {
      this.state.shot = null;
      this.state.pointer = null;
    }
    this.state.status = status;
    const main = this.options.getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send('computer:status-changed', { ...status });
  }

  clearShot(): void {
    this.generation += 1;
    this.state.shot = null;
    this.state.pointer = null;
    this.publish();
  }

  beginOperation(): number {
    this.state.inFlight += 1;
    this.publish();
    return this.generation;
  }

  beginScreenshot(status = this.options.getStatus()): CaptureToken {
    this.state.inFlight += 1;
    this.statusChanged(false, status);
    return { generation: this.generation, requestSeq: ++this.captureSeq, targetRevision: status.targetRevision };
  }

  /** Guard both the viewer and the result returned to the agent/model. */
  async capture(expectedRevision?: number): Promise<CaptureResult> {
    const status = this.options.getStatus();
    if (!status.enabled) return { error: 'Computer control is switched off. No screenshot was captured.' };
    if (expectedRevision !== undefined && expectedRevision !== status.targetRevision) {
      return { error: 'The selected app changed. Request a new screenshot.' };
    }
    const pending = this.activeCapture;
    if (pending && pending.token.targetRevision === status.targetRevision && pending.token.generation === this.generation) {
      return pending.result;
    }

    const token = this.beginScreenshot(status);
    const result = this.captureFrame(token);
    this.activeCapture = { token, result };
    try {
      return await result;
    } finally {
      if (this.activeCapture?.result === result) this.activeCapture = undefined;
    }
  }

  private async captureFrame(token: CaptureToken): Promise<CaptureResult> {
    let result: CaptureResult;
    try {
      result = await this.options.screenshot(token.targetRevision);
    } catch (error) {
      this.endScreenshot({ error: String(error) }, token);
      throw error;
    }
    const accepted = this.endScreenshot(result, token);
    return 'dataUrl' in result && !accepted ? { error: 'Screenshot discarded: control changed or a newer capture was requested.' } : result;
  }

  endScreenshot(result: CaptureResult, token: CaptureToken): boolean {
    this.state.inFlight = Math.max(0, this.state.inFlight - 1);
    // Disabling/re-enabling or emergency stop fences captures started earlier.
    const status = this.options.getStatus();
    const accepted = token.generation === this.generation && token.requestSeq === this.captureSeq
      && status.targetRevision === token.targetRevision && status.enabled && 'dataUrl' in result && status.frameId === result.frameId
      && status.target?.id === result.target.id && /^data:image\/(?:png|jpe?g|webp);base64,/.test(result.dataUrl);
    if (accepted && 'dataUrl' in result) {
      const pointer = this.state.pointer;
      const previous = this.state.shot;
      const geometry = result.geometry;
      this.state.pointer = pointer && pointer.frameId === previous?.frameId &&
        previous.geometry.captureWidth === geometry.captureWidth && previous.geometry.captureHeight === geometry.captureHeight &&
        previous.geometry.logicalWidth === geometry.logicalWidth && previous.geometry.logicalHeight === geometry.logicalHeight
        ? { ...pointer, frameId: result.frameId } : null;
      this.state.shot = { ...result, capturedAt: Date.now() };
      const win = this.window;
      const ratio = geometry.captureWidth / geometry.captureHeight;
      if (win && !win.isDestroyed() && ratio !== this.aspectRatio) {
        const area = this.options.getWorkArea();
        const width = Math.max(1, Math.round(Math.min(win.getSize()[0], area.width, area.height * ratio)));
        this.aspectRatio = ratio;
        win.setAspectRatio(ratio);
        win.setSize(width, Math.max(1, Math.round(width / ratio)));
      }
    }
    this.statusChanged(false, status);
    return accepted;
  }

  async runAction(req: ComputerRequest, source: ComputerPreviewPointer['source'] = 'agent'): Promise<ComputerActionResult> {
    const shot = this.state.shot;
    const status = this.options.getStatus();
    const hasPointer = status.platform === 'darwin' ? req?.action === 'left_click' :
      status.platform === 'win32' && windowsPointerActions.has(req?.action);
    let pointer: ComputerPreviewPointer | undefined;
    if (hasPointer && !this.state.inFlight && status.enabled && status.accessibility && shot && status.frameId === shot.frameId &&
        req.frameId === shot.frameId && req.coordinate && !validateComputerRequest(req)) {
      pointer = {
        id: ++this.pointerSeq, frameId: shot.frameId, action: req.action, phase: 'pending', source,
        coordinate: toCapturePoint(toLogicalPoint(req.coordinate, shot.geometry), shot.geometry),
      };
      this.state.pointer = pointer;
    }
    this.beginOperation();
    let result: ComputerActionResult;
    try {
      result = await this.options.act(req);
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (pointer && this.state.pointer?.id === pointer.id) {
      this.state.pointer = result.ok ? { ...pointer, phase: 'sent' } : null;
    }
    this.endAction(req, result);
    return result;
  }

  private async manualAction(input: unknown): Promise<ComputerPreviewCommandResult> {
    const status = this.options.getStatus();
    const shot = this.state.shot;
    if (!status.enabled || !status.target) return { ok: false, message: 'Enable Computer Use and select an app window first.' };
    if (this.state.inFlight) return { ok: false, message: 'Another computer action is in progress.' };
    const req = previewInput(input, status.platform);
    if (!req) return { ok: false, message: 'This input is unavailable in the preview.' };
    if (!shot || req.frameId !== shot.frameId || status.frameId !== shot.frameId || status.target.id !== shot.target.id) {
      return { ok: false, message: 'The preview frame changed. Refresh it before acting.' };
    }
    if (req.coordinate && (req.coordinate[0] >= shot.geometry.captureWidth || req.coordinate[1] >= shot.geometry.captureHeight)) {
      return { ok: false, message: 'Choose a point inside the preview image.' };
    }
    const { ok, message } = await this.runAction(req, 'manual');
    if (!ok) return { ok, message };
    const refreshed = await this.refresh(status.targetRevision);
    return refreshed.ok ? { ok, message } : { ok, message, warning: refreshed.message };
  }

  private async refresh(revision: unknown): Promise<ComputerPreviewCommandResult> {
    const status = this.options.getStatus();
    if (!status.enabled || !status.target || status.targetRevision !== revision) {
      return { ok: false, message: 'The selected app changed. Wait for the current target before refreshing.' };
    }
    if (this.state.inFlight && !this.activeCapture) return { ok: false, message: 'Another computer action is in progress.' };
    try {
      const result = await this.capture(status.targetRevision);
      return 'error' in result ? { ok: false, message: result.error } : { ok: true, message: `Captured ${result.target.name}.` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
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

  private advanceRevision(): void {
    this.state.revision += 1;
    this.state.updatedAt = Date.now();
  }

  private publish(): void {
    this.advanceRevision();
    if (!this.window || this.window.isDestroyed()) return;
    const shot = this.state.shot;
    const update: ComputerPreviewUpdate = { ...this.state };
    if (shot && shot.frameId === this.publishedFrameId) {
      // Busy and pointer transitions can reuse the image already in the viewer.
      const { dataUrl, ...frame } = shot;
      update.shot = frame;
    }
    this.window.webContents.send(CHANNELS.state, update);
    this.publishedFrameId = shot?.frameId ?? null;
  }

  private publishVisibility(): void {
    const main = this.options.getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send(CHANNELS.visibility, this.visibility());
  }
}
