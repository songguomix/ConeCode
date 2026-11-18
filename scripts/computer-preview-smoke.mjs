// Native-window smoke test. Fixture pixels only; never imports the computer
// controller, captures the desktop, or generates global mouse/keyboard input.
import { build } from 'esbuild';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const { values } = parseArgs({ options: { 'out-dir': { type: 'string' }, 'hold-ms': { type: 'string' } } });
const repo = process.cwd();
const outDir = path.resolve(values['out-dir'] ?? path.join(tmpdir(), 'conecode-preview-smoke-evidence'));
const holdMs = Number(values['hold-ms'] ?? 0);
if (!Number.isInteger(holdMs) || holdMs < 0 || holdMs > 120_000) throw new Error('hold-ms must be 0–120000');
await mkdir(outDir, { recursive: true });
const dir = await mkdtemp(path.join(tmpdir(), 'conecode-native-preview-'));
const require = createRequire(import.meta.url);
const { _electron } = await import(pathToFileURL(path.join(repo, 'cua/node_modules/playwright/index.mjs')).href);
let application;
try {
  await build({
    entryPoints: [path.join(repo, 'electron/computer/preview-window.ts')],
    outfile: path.join(dir, 'manager.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22',
  });
  const harness = `const {app,BrowserWindow,ipcMain,screen}=require('electron');
const {ComputerPreviewWindow}=require('./manager.cjs');
app.setName('ConeCode Preview Smoke');app.setPath('userData',${JSON.stringify(path.join(dir, 'user-data'))});
app.whenReady().then(async()=>{
  const main=new BrowserWindow({show:false,width:640,height:360,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await main.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta charset="utf-8"><title>Fixture only</title><body style="margin:0;background:#123042;color:white;font:28px system-ui;padding:36px"><h2>FIXTURE ONLY</h2><p id="fixture-note">Native preview smoke test</p><p style="font-size:18px;color:#a6d5e5">No desktop capture or computer actions.</p></body>'));
  const target = { id: 'fixture-window', name: 'Fixture', title: 'Fixture only' };
  const status = {
    platform: process.platform, enabled: true, supported: true, accessibility: true, screenRecording: true,
    geometry: null, target, targetRevision: 1, frameId: null,
  };
  const actions = [];
  let captureCount = 0;
  let unblockAction;
  const screenshot = async (expectedRevision) => {
    if (!status.enabled || (expectedRevision !== undefined && expectedRevision !== status.targetRevision)) {
      return { error: 'The fixture selection changed.' };
    }
    await main.webContents.executeJavaScript('document.getElementById("fixture-note").textContent = ' + JSON.stringify('Fixture capture ' + (captureCount + 1)));
    const pixels = await main.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    const size = pixels.getSize();
    const geometry = { logicalWidth: 640, logicalHeight: 360, captureWidth: size.width, captureHeight: size.height };
    status.geometry = geometry;
    status.frameId = 'fixture-frame-' + ++captureCount;
    return { dataUrl: pixels.toDataURL(), geometry, target, frameId: status.frameId };
  };
  const manager = new ComputerPreviewWindow({
    createWindow: (options) => new BrowserWindow(options),
    getMainWindow: () => main,
    getStatus: () => ({ ...status }),
    getWorkArea: () => screen.getPrimaryDisplay().workArea,
    preloadPath: ${JSON.stringify(path.join(repo, 'dist-electron/computer-preview-preload.js'))},
    indexFile: ${JSON.stringify(path.join(repo, 'dist/index.html'))},
    act: async (request) => {
      if (!status.enabled || request.frameId !== status.frameId) return { ok: false, message: 'The fixture frame changed.' };
      actions.push(request);
      if (actions.length === 1) await new Promise((resolve) => { unblockAction = resolve; });
      return { ok: true, target, message: 'Fixture action recorded.' };
    },
    screenshot,
  });
  manager.register(ipcMain);
  await manager.open({ locale: 'en', theme: 'dark' });
  const initialFrame = await manager.capture(status.targetRevision);
  if ('error' in initialFrame) throw new Error(initialFrame.error);
  globalThis.previewSmoke = { manager, status, actions, releaseAction: () => unblockAction?.() };
  app.on('before-quit',()=>manager.destroy());
}).catch(error=>{console.error(error);app.exit(1);});`;
  await writeFile(path.join(dir, 'main.cjs'), harness, { mode: 0o600 });
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: require('electron'), args: [path.join(dir, 'main.cjs')], cwd: repo, env: environment, timeout: 30_000 });
  await application.evaluate(async () => {
    const deadline = Date.now() + 20_000;
    while (!globalThis.previewSmoke && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!globalThis.previewSmoke) throw new Error('Native preview did not initialize');
  });
  const page = application.windows().find((candidate) => candidate.url().endsWith('#computer-preview'));
  assert.ok(page, 'Preview page exists');
  const surface = page.getByTestId('computer-preview-window');
  const control = page.getByTestId('computer-preview-control');
  const refresh = page.getByTestId('computer-preview-refresh');
  const image = page.locator('.computer-preview-image');
  await surface.waitFor();
  await image.locator('img').waitFor({ state: 'visible' });
  const isolated = await page.evaluate(() => ({
    keys: Object.keys(window.computerPreviewAPI).sort(), hasElectronAPI: typeof window.electronAPI !== 'undefined', hasRequire: typeof window.require !== 'undefined',
  }));
  assert.deepEqual(isolated.keys, ['act', 'getState', 'onState', 'refresh']);
  assert.equal(isolated.hasElectronAPI, false);
  assert.equal(isolated.hasRequire, false);
  assert.equal(await page.locator('iframe,webview').count(), 0);
  assert.equal(await control.getAttribute('aria-pressed'), 'false');
  assert.equal(await surface.evaluate((element) => getComputedStyle(element).webkitAppRegion), 'drag');
  const native = await application.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('#computer-preview'));
    if (!win) throw new Error('Native preview window missing');
    const initial = win.getBounds();
    const area = screen.getDisplayMatching(initial).workArea;
    win.setPosition(Math.max(area.x, initial.x - 80), Math.max(area.y, initial.y - 50));
    const moved = win.getBounds();
    win.setSize(initial.width + 60, initial.height);
    return {
      alwaysOnTop: win.isAlwaysOnTop(), movable: win.isMovable(), resizable: win.isResizable(),
      initial, moved, resized: win.getBounds(), focusedAfterOpen: win.isFocused(),
      preferences: (({ nodeIntegration, contextIsolation, sandbox, preload }) => ({ nodeIntegration, contextIsolation, sandbox, preload }))(win.webContents.getLastWebPreferences()),
    };
  });
  assert.equal(native.alwaysOnTop, true); assert.equal(native.movable, true); assert.equal(native.resizable, true);
  assert.notDeepEqual(native.initial, native.moved); assert.ok(native.resized.width > native.initial.width);
  assert.equal(native.preferences.nodeIntegration, false); assert.equal(native.preferences.contextIsolation, true); assert.equal(native.preferences.sandbox, true);
  const networkBlocked = await page.evaluate(() => fetch('https://blocked.invalid/test').then(() => false, () => true));
  assert.equal(networkBlocked, true);

  // Agent input follows the same manager path as the main application's IPC.
  await application.evaluate(() => {
    const { manager, status } = globalThis.previewSmoke;
    const { captureWidth, captureHeight } = status.geometry;
    globalThis.previewSmoke.agentAction = manager.runAction({
      action: 'left_click',
      frameId: status.frameId,
      coordinate: [Math.floor(captureWidth * 0.28), Math.floor(captureHeight * 0.38)],
    });
  });
  const cursor = page.locator('.computer-preview-pointer');
  await page.locator('.computer-preview-pointer[data-phase="pending"][data-source="agent"] .computer-preview-arrow').waitFor({ state: 'visible' });
  const cursorPosition = await cursor.evaluate((element) => ({ left: parseFloat(element.style.left), top: parseFloat(element.style.top) }));
  assert.ok(Math.abs(cursorPosition.left - 28) < 1 && Math.abs(cursorPosition.top - 38) < 1, JSON.stringify(cursorPosition));
  const agentAction = await application.evaluate(async () => {
    globalThis.previewSmoke.releaseAction();
    return globalThis.previewSmoke.agentAction;
  });
  assert.equal(agentAction.ok, true);
  await page.locator('.computer-preview-pointer[data-phase="sent"] .computer-preview-arrow').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(outDir, 'preview-fixture.png') });

  // Enter manual mode and click a known position in the contained image.
  await control.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="computer-preview-control"]')?.getAttribute('aria-pressed') === 'true');
  assert.equal(await image.evaluate((element) => getComputedStyle(element).webkitAppRegion), 'no-drag');
  assert.equal(await page.locator('.computer-preview-drag').evaluate((element) => getComputedStyle(element).webkitAppRegion), 'drag');
  await page.waitForFunction(() => document.querySelector('.computer-preview-image img')?.naturalWidth > 0);
  const frameBeforeClick = await page.evaluate(() => window.computerPreviewAPI.getState());
  const position = await image.boundingBox();
  assert.ok(position, 'Contained screenshot has a click area');
  const viewport = await surface.boundingBox();
  assert.ok(viewport && viewport.width - position.width > 10 && position.x > viewport.x, 'The image is horizontally letterboxed');
  const x = Math.floor(position.width * 0.34);
  const y = Math.floor(position.height * 0.58);
  await page.mouse.click(position.x + x, position.y + y);
  await page.waitForFunction(async (frameId) => {
    const state = await window.computerPreviewAPI.getState();
    return state.shot && state.shot.frameId !== frameId;
  }, frameBeforeClick.shot.frameId);
  const recorded = await application.evaluate(() => globalThis.previewSmoke.actions.slice());
  assert.equal(recorded.length, 2);
  const manual = recorded[1];
  const { captureWidth, captureHeight } = frameBeforeClick.shot.geometry;
  assert.equal(manual.action, 'left_click');
  assert.equal(manual.frameId, frameBeforeClick.shot.frameId);
  assert.ok(Math.abs(manual.coordinate[0] / captureWidth - x / position.width) < 0.01, JSON.stringify(manual));
  assert.ok(Math.abs(manual.coordinate[1] / captureHeight - y / position.height) < 0.01, JSON.stringify(manual));
  await page.locator('.computer-preview-pointer[data-phase="sent"][data-source="manual"] .computer-preview-arrow').waitFor({ state: 'visible' });
  const staleClick = await page.evaluate((request) => window.computerPreviewAPI.act(request), manual);
  assert.equal(staleClick.ok, false);
  const sizeAfterClick = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .find((candidate) => candidate.webContents.getURL().endsWith('#computer-preview')).getBounds());
  assert.deepEqual(sizeAfterClick, native.resized);

  const frameBeforeText = await page.evaluate(async () => (await window.computerPreviewAPI.getState()).shot.frameId);
  await page.getByRole('button', { name: 'Text to enter' }).click();
  const textForm = page.locator('.computer-preview-text');
  await textForm.getByRole('textbox').fill('Fixture text');
  await textForm.getByRole('button', { name: 'Send text' }).click();
  await textForm.waitFor({ state: 'hidden' });
  const textAction = await application.evaluate(() => globalThis.previewSmoke.actions.at(-1));
  assert.deepEqual(textAction, { action: 'type', frameId: frameBeforeText, text: 'Fixture text' });

  const frameBeforeRefresh = await page.evaluate(async () => (await window.computerPreviewAPI.getState()).shot.frameId);
  await refresh.click();
  await page.waitForFunction(async (frameId) => {
    const state = await window.computerPreviewAPI.getState();
    return state.shot && state.shot.frameId !== frameId;
  }, frameBeforeRefresh);
  assert.equal(await application.evaluate(() => globalThis.previewSmoke.actions.length), 3);
  await control.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="computer-preview-control"]')?.getAttribute('aria-pressed') === 'false');
  if (holdMs) {
    console.log(JSON.stringify({ readyForManualDrag: true, holdMs, fixtureOnly: true, output: outDir, executable: require('electron'), pid: application.process().pid, bounds: native.resized, title: await page.title() }));
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
  await application.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('#computer-preview'));
    win.minimize();
    const deadline = Date.now() + 3_000;
    while (!win.isMinimized() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (!win.isMinimized()) throw new Error('Minimize did not reach native window');
    await globalThis.previewSmoke.manager.open();
  });
  await page.waitForFunction(() => document.visibilityState === 'visible');
  await application.evaluate(() => {
    const smoke = globalThis.previewSmoke;
    const shot = smoke.manager.snapshot().shot;
    const pending = smoke.manager.beginScreenshot();
    smoke.status.enabled = false;
    smoke.manager.statusChanged(true);
    smoke.manager.endScreenshot(shot, pending);
  });
  const stopped = await page.evaluate(() => window.computerPreviewAPI.getState());
  assert.equal(stopped.status.enabled, false); assert.equal(stopped.shot, null); assert.equal(stopped.inFlight, 0);
  const closed = page.waitForEvent('close');
  await application.evaluate(() => globalThis.previewSmoke.manager.close()); await closed;
  const remains = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.webContents.getURL().endsWith('#computer-preview')));
  assert.equal(remains, false);
  const report = {
    mode: 'real-electron-window-fixture-state', measuredAt: new Date().toISOString(), platform: process.platform,
    desktopCaptured: false, realComputerActions: false, fixturePixels: true, isolated, native, networkBlocked,
    noEmbeddedUI: true, frameBoundManualClickOnContainedImage: true, staleFrameClickRejected: true, refreshAfterManualClick: true, manualText: true, explicitRefresh: true,
    agentPointerPendingAndSent: true, manualPointerSent: true, resizedBoundsPreserved: true,
    programmaticMinimizeAndReopen: true, disabledLateCaptureFence: true, closeLifecycle: true,
    dragVerification: 'Native movable flag, draggable watch surface and dedicated manual drag area, and programmatic bounds change checked.',
    screenshot: path.join(outDir, 'preview-fixture.png'),
  };
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await application?.close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}
