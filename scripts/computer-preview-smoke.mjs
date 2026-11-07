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
  await main.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta charset="utf-8"><title>Fixture only</title><body style="margin:0;background:#123042;color:white;font:28px system-ui;padding:36px"><h2>FIXTURE ONLY</h2><p>Native preview smoke test</p><p style="font-size:18px;color:#a6d5e5">No desktop capture or computer actions.</p></body>'));
  const pixels=await main.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
  const size=pixels.getSize();const geometry={logicalWidth:640,logicalHeight:360,captureWidth:size.width,captureHeight:size.height};
  const status={platform:process.platform,enabled:true,supported:true,accessibility:true,screenRecording:true,geometry};
  const manager=new ComputerPreviewWindow({createWindow:opts=>new BrowserWindow(opts),getMainWindow:()=>main,getStatus:()=>({...status}),getWorkArea:()=>screen.getPrimaryDisplay().workArea,preloadPath:${JSON.stringify(path.join(repo, 'dist-electron/computer-preview-preload.js'))},indexFile:${JSON.stringify(path.join(repo, 'dist/index.html'))}});
  manager.register(ipcMain);await manager.open({locale:'en',theme:'dark'});
  const image={dataUrl:pixels.toDataURL(),geometry};await manager.capture(async()=>image);
  globalThis.previewSmoke={manager,image,status};
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
  await page.locator('[data-testid="computer-preview-window"]').waitFor();
  await page.locator('.computer-preview-surface img').waitFor({ state: 'visible' });
  const isolated = await page.evaluate(() => ({
    keys: Object.keys(window.computerPreviewAPI).sort(), hasElectronAPI: typeof window.electronAPI !== 'undefined', hasRequire: typeof window.require !== 'undefined',
  }));
  assert.deepEqual(isolated.keys, ['getState', 'onState']);
  assert.equal(isolated.hasElectronAPI, false);
  assert.equal(isolated.hasRequire, false);
  assert.equal(await page.locator('button,iframe,webview').count(), 0);
  assert.equal(await page.locator('.computer-preview-surface').evaluate((surface) => getComputedStyle(surface).webkitAppRegion), 'drag');
  const native = await application.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('#computer-preview'));
    if (!win) throw new Error('Native preview window missing');
    const initial = win.getBounds();
    const area = screen.getDisplayMatching(initial).workArea;
    win.setPosition(Math.max(area.x, initial.x - 80), Math.max(area.y, initial.y - 50));
    const moved = win.getBounds();
    win.setSize(initial.width + 24, Math.round((initial.width + 24) * initial.height / initial.width));
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
  await page.screenshot({ path: path.join(outDir, 'preview-fixture.png') });
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
    const pending = smoke.manager.beginScreenshot();
    smoke.status.enabled = false;
    smoke.manager.statusChanged(true);
    smoke.manager.endScreenshot(smoke.image, pending);
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
    noButtonsOrEmbeddedUI: true, readOnlyPreviewAPI: true,
    programmaticMinimizeAndReopen: true, disabledLateCaptureFence: true, closeLifecycle: true,
    dragVerification: 'Native movable flag, draggable full surface, and programmatic bounds change checked; physical drag requires the separate manual/CUA check.',
    screenshot: path.join(outDir, 'preview-fixture.png'),
  };
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await application?.close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}
