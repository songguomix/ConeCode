import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacDesktopDriver } from '../src/drivers/desktop/macos-driver.js';
import { ArtifactStore } from '../src/store/artifacts.js';
import { SessionStore } from '../src/store/store.js';
import { newId } from '../src/protocol/ids.js';
import { nowIso } from '../src/protocol/schemas.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { viewportToScreenshot } from '../src/drivers/browser/coordinates.js';

const runFile = promisify(execFile);

const isMac = process.platform === 'darwin';
const hasHelper = existsSync(join(process.cwd(), 'native', 'bin', 'desktop-agent'));
const desktopOptIn = process.env.CUA_RUN_DESKTOP === '1';
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => undefined);
});

async function makeDriver() {
  const store = new SessionStore(':memory:');
  const artifactsRoot = await mkdtemp(join(tmpdir(), 'cua-desktop-artifacts-'));
  const artifacts = new ArtifactStore(artifactsRoot, store);
  const taskId = newId('task');
  const suffix = taskId.slice(5);
  const driver = new MacDesktopDriver(
    { taskId, runId: `run_${suffix}`, sessionId: `ses_${suffix}` },
    { kind: 'desktop' },
    artifacts,
    { helperPath: join(process.cwd(), 'native', 'bin', 'desktop-agent') },
  );
  await driver.start();
  cleanups.push(async () => {
    await driver.close();
    store.close();
    await rm(artifactsRoot, { recursive: true, force: true });
  });
  return { driver, store, taskId, runId: `run_${suffix}`, sessionId: `ses_${suffix}` };
}

function proposal(ids: { taskId: string; runId: string; sessionId: string }, observation: any, action: any) {
  return {
    schemaVersion: 1,
    id: newId('act'),
    taskId: ids.taskId,
    runId: ids.runId,
    sessionId: ids.sessionId,
    observationId: observation.id,
    surfaceId: observation.surfaceId,
    generation: observation.generation,
    action,
    expected: [],
    risk: 'reversible',
    requiresApproval: false,
    rationale: 'desktop test',
    createdAt: nowIso(),
    attempts: 0,
    observation,
  } as any;
}

describe.runIf(isMac && hasHelper)('macOS native desktop driver (requires compiled helper)', () => {
  it('detects screens and reports actual permission capabilities without input', async () => {
    const { driver } = await makeDriver();
    const status = await driver.status();
    expect(status.platform).toBe('darwin');
    expect(typeof status.screenRecording).toBe('boolean');
    expect(typeof status.eventAccess).toBe('boolean');
    expect(driver.capabilities().screenshot).toBe(status.screenRecording);
    expect(driver.capabilities().click).toBe(status.eventAccess);
  });

  it.runIf(desktopOptIn)('captures a real screenshot or explicitly reports missing permission', async () => {
    const { driver } = await makeDriver();
    const status = await driver.status();
    if (!status.screenRecording) {
      await expect(driver.observe()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
      return;
    }
    const observation = await driver.observe();
    expect(observation.interface.kind).toBe('desktop');
    expect(observation.screenshot?.width).toBeGreaterThan(0);
    expect(observation.screenshot?.height).toBeGreaterThan(0);
    expect(observation.coverage.coverageNotes.join(' ')).toMatch(/Desktop observations are visual/);
  });

  it('refuses synthetic input honestly when Accessibility is not granted', async () => {
    const { driver } = await makeDriver();
    const status = await driver.status();
    const observation = { id: newId('obs'), surfaceId: driver.surfaceId(), generation: driver.generation() };
    const before = status.frontmost;
    if (status.eventAccess) {
      // A granted environment must not be tested with a blind click on the
      // user's real desktop by default.
      expect(driver.capabilities().click).toBe(true);
      return;
    }
    await expect(
      driver.execute(proposal({ taskId: 'task_00000000-0000-0000-0000-000000000001', runId: 'run_00000000-0000-0000-0000-000000000001', sessionId: 'ses_00000000-0000-0000-0000-000000000001' }, observation, {
        tool: 'desktop.click', x: 10, y: 10, button: 'left', clickCount: 1,
      })),
    ).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
    const after = (await driver.status()).frontmost;
    expect(after).toEqual(before);
    expect(driver.capabilities().click).toBe(false);
  });

  it.runIf(desktopOptIn)('invokes app focus and reports the actual frontmost app (screen may be locked)', async () => {
    const { driver, taskId, runId, sessionId } = await makeDriver();
    const observation = await driver.observe();
    const result = await driver.execute(
      proposal({ taskId, runId, sessionId }, observation, { tool: 'desktop.focus_app', appName: 'TextEdit' }),
    );
    expect(result.actual.focus).toMatchObject({ appName: 'TextEdit' });
    const status = await driver.status();
    // This machine's session may be locked (loginwindow), so the test records
    // the real foreground app rather than claiming focus switching succeeded.
    expect(status.frontmost.appName).toBeTruthy();
  });

  it.runIf(desktopOptIn)('types Unicode with native input after focus/window changes, then saves via app scripting', async () => {
    const { driver, taskId, runId, sessionId } = await makeDriver();
    expect((await driver.status()).eventAccess).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), 'cua-native-input-'));
    const name = `native-${newId('run')}.txt`;
    const path = join(dir, name);
    const ids = { taskId, runId, sessionId };
    let documentName = '';
    const script = `on run argv
tell application "TextEdit"
  activate
  set fixtureDoc to make new document
  set text of fixtureDoc to ""
  set bounds of window 1 to {60, 100, 900, 720}
  return name of fixtureDoc
end tell
end run`;
    try {
      // Preparation creates only an empty fixture. All content below is typed
      // through the real native driver; read-back is independent evidence.
      const created = await runFile('/usr/bin/osascript', ['-e', script], { timeout: 30_000 });
      documentName = created.stdout.trim();
      expect(documentName.length).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      let observation = await driver.observe();
      expect((await driver.status()).frontmost.bundleId).toBe('com.apple.TextEdit');
      expect(observation.interface.windowTitle).toBe(documentName);
      await runFile('/usr/bin/osascript', ['-e', 'tell application "TextEdit" to set bounds of window 1 to {100, 140, 940, 760}'], { timeout: 10_000 });
      expect((await driver.freshness()).generation).toBeGreaterThan(observation.generation);
      await driver.execute(proposal(ids, observation, { tool: 'desktop.focus_app', appName: 'Finder' }));
      for (let attempt = 0; attempt < 20 && (await driver.status()).frontmost.bundleId !== 'com.apple.finder'; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await driver.status()).frontmost.bundleId).toBe('com.apple.finder');
      await driver.execute(proposal(ids, observation, { tool: 'desktop.focus_app', appName: 'TextEdit' }));
      for (let attempt = 0; attempt < 20 && (await driver.status()).frontmost.bundleId !== 'com.apple.TextEdit'; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
      observation = await driver.observe();
      expect(observation.interface.windowTitle).toBe(documentName);
      const status = await driver.status();
      const bounds = (status.frontmost as any).windowBounds;
      expect(bounds).toBeTruthy();
      const [x, y] = viewportToScreenshot({ x: bounds.X + 180, y: bounds.Y + 160 }, observation.screenshot!);
      await driver.execute(proposal(ids, observation, { tool: 'desktop.click', x, y, button: 'left', clickCount: 1 }));
      observation = await driver.observe();
      const content = '原生输入验收：你好，世界。\nUnicode ✅ — native CGEvent.';
      await driver.execute(proposal(ids, observation, { tool: 'desktop.type', text: 'must be replaced' }));
      observation = await driver.observe();
      await driver.execute(proposal(ids, observation, { tool: 'desktop.key', key: 'Meta+A' }));
      observation = await driver.observe();
      await driver.execute(proposal(ids, observation, { tool: 'desktop.type', text: content }));
      observation = await driver.observe();
      expect(observation.interface.windowTitle).toBe(documentName);
      await runFile('/usr/bin/osascript', ['-e', 'on run argv\ntell application "TextEdit" to save document (item 1 of argv) in POSIX file (item 2 of argv)\nend run', documentName, path], { timeout: 30_000 });
      for (let attempt = 0; attempt < 20 && await readFile(path, 'utf8') !== content; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await readFile(path, 'utf8')).toBe(content);
    } finally {
      if (documentName) await runFile('/usr/bin/osascript', ['-e', `on run argv\ntell application "TextEdit"\nif exists document (item 1 of argv) then close document (item 1 of argv) saving no\nend tell\nend run`, documentName], { timeout: 10_000 }).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(desktopOptIn)('writes and saves a Unicode document through TextEdit, then verifies the file', async () => {
    const { driver, taskId, runId, sessionId } = await makeDriver();
    const dir = await mkdtemp(join(tmpdir(), 'cua-desktop-save-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'note.txt');
    const content = '桌面验收：你好，世界。\nUnicode ✅ — saved by the app-scripting channel.';
    const observation = await driver.observe();
    const result = await driver.execute(
      proposal({ taskId, runId, sessionId }, observation, {
        tool: 'desktop.edit_document',
        appName: 'TextEdit',
        content,
        savePath: path,
      }),
    );
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(result.actual.contentMatches).toBe(true);
    expect(result.actual.bytes).toBeGreaterThan(0);
    expect(result.evidence.some((e) => e.kind === 'file')).toBe(true);
  });
});
