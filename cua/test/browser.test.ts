import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from '../src/fixtures/web-app.js';
import { BrowserDriver } from '../src/drivers/browser/browser-driver.js';
import { ArtifactStore } from '../src/store/artifacts.js';
import { SessionStore } from '../src/store/store.js';
import { newId } from '../src/protocol/ids.js';
import { DEFAULT_BUDGET, nowIso, type Action, type ActionProposal, type Condition, type Task } from '../src/protocol/schemas.js';
import { Executor } from '../src/agent/executor.js';
import { Verifier } from '../src/agent/verifier.js';
import { BudgetTracker, CancellationToken } from '../src/runtime/control.js';
import { viewportToScreenshot } from '../src/drivers/browser/coordinates.js';

let fixture: FixtureServer;
let artifactsRoot: string;

beforeAll(async () => {
  fixture = await startFixtureServer();
  artifactsRoot = await mkdtemp(join(tmpdir(), 'cua-browser-test-artifacts-'));
});
afterAll(async () => {
  await fixture?.close();
  if (artifactsRoot) await rm(artifactsRoot, { recursive: true, force: true });
});

interface Harness {
  store: SessionStore;
  driver: BrowserDriver;
  task: Task;
  proposal(observation: any, action: Action, expected?: Condition[]): ActionProposal;
  close(): Promise<void>;
}

async function harness(startPath = '/', config: ConstructorParameters<typeof BrowserDriver>[3] = {}): Promise<Harness> {
  const store = new SessionStore(':memory:');
  const artifacts = new ArtifactStore(artifactsRoot, store);
  const prefix = newId('task');
  const suffix = prefix.slice(5);
  const taskId = `task_${suffix}`;
  const runId = `run_${suffix}`;
  const sessionId = `ses_${suffix}`;
  const task: Task = {
    schemaVersion: 1, id: taskId, runId, goal: 'browser test', constraints: [],
    acceptance: [{ kind: 'text_visible', text: 'Project Console' }], acceptanceSource: 'user',
    authorization: { allowedOrigins: [fixture.url], allowedTools: [], allowDesktop: false, allowCode: false, allowedFileRoots: [], allowedRecipients: [] },
    budgets: { ...DEFAULT_BUDGET, maxSteps: 100 }, environment: { kind: 'browser', startUrl: fixture.url + startPath, profile: 'default', headless: true },
    status: 'created', createdAt: nowIso(), updatedAt: nowIso(), version: 0, sessionId, metadata: {},
  };
  store.createTask(task);
  store.createSession({
    schemaVersion: 1, id: sessionId, taskId, runId, kind: 'browser', environment: task.environment,
    lifecycle: 'starting', ownerId: 'test', fencingToken: 1,
    capabilities: { observe: true, screenshot: true, click: true, type: true, unicodeType: true, scroll: true, drag: true, key: true, tabs: true, code: true, actions: [], notes: [] },
    createdAt: nowIso(), updatedAt: nowIso(),
  });
  const driver = new BrowserDriver(
    { taskId, runId, sessionId },
    { kind: 'browser', startUrl: fixture.url + startPath, profile: 'default', headless: true },
    artifacts,
    config,
  );
  await driver.start();
  return {
    store,
    driver,
    task,
    proposal(observation, action, expected = []) {
      return {
        schemaVersion: 1, id: newId('act'), taskId, runId, sessionId,
        observationId: observation.id, surfaceId: observation.surfaceId, generation: observation.generation,
        action, expected, risk: 'reversible', requiresApproval: false, rationale: 'test', createdAt: nowIso(), attempts: 0,
      };
    },
    async close() {
      await driver.close();
      store.close();
    },
  };
}

async function execute(h: Harness, observation: any, action: Action, expected: Condition[] = []) {
  const proposal = h.proposal(observation, action, expected);
  return new Executor(h.store, new Verifier()).execute({
    task: h.task,
    observation,
    proposal,
    driver: h.driver,
    budget: new BudgetTracker(h.task.budgets),
    cancellation: new CancellationToken(),
    approved: true,
  });
}

describe('real browser observation and actions', () => {
  it('captures structured targets, text, tabs and a real screenshot', async () => {
    const h = await harness('/');
    try {
      const observation = await h.driver.observe();
      expect(observation.interface.title).toContain('Project Console');
      expect(observation.targets.some((t) => t.role === 'textbox' && t.name === 'Project name')).toBe(true);
      expect(observation.targets.some((t) => t.role === 'button' && t.name === 'Save')).toBe(true);
      expect(observation.visibleText).toContain('Project Console');
      expect(observation.screenshot?.width).toBeGreaterThan(0);
      expect(observation.screenshot?.artifactId).toMatch(/^art_/);
      expect(observation.coverage.coverageNotes.join(' ')).toContain('Only the viewport is captured');
    } finally {
      await h.close();
    }
  });

  it('marks duplicate buttons with duplicate keys instead of silently picking one', async () => {
    const h = await harness('/list');
    try {
      const observation = await h.driver.observe();
      const opens = observation.targets.filter((t) => t.role === 'button' && t.name === 'Open');
      expect(opens.length).toBe(2);
      expect(opens.every((t) => t.duplicateKey)).toBe(true);
      expect(new Set(opens.map((t) => t.targetId)).size).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('observes and acts inside an iframe and an open shadow root', async () => {
    const h = await harness('/iframe');
    try {
      let observation = await h.driver.observe();
      const iframeButton = observation.targets.find((t) => t.name === 'Inside iframe');
      const shadowButton = observation.targets.find((t) => t.name === 'Shadow action');
      expect(iframeButton?.frameId).not.toBe('main');
      expect(observation.coverage.shadowRoots).toBeGreaterThan(0);
      expect(shadowButton).toBeTruthy();
      await h.driver.execute({ ...h.proposal(observation, { tool: 'browser.click', targetId: iframeButton!.targetId, button: 'left', clickCount: 1 }), observation } as any);
      await h.driver.execute({ ...h.proposal(observation, { tool: 'browser.click', targetId: shadowButton!.targetId, button: 'left', clickCount: 1 }), observation } as any);
      const iframeProbe = await h.driver.probe({ kind: 'text_visible', text: 'Iframe action completed' });
      const shadowProbe = await h.driver.probe({ kind: 'text_visible', text: 'Shadow action completed' });
      expect(iframeProbe.verdict).toBe('pass');
      expect(shadowProbe.verdict).toBe('pass');
    } finally {
      await h.close();
    }
  });

  it('handles an HTML modal and waits for delayed content', async () => {
    const h = await harness('/modal');
    try {
      let observation = await h.driver.observe();
      const open = observation.targets.find((t) => t.name === 'Open confirmation')!;
      await h.driver.execute({ ...h.proposal(observation, { tool: 'browser.click', targetId: open.targetId, button: 'left', clickCount: 1 }), observation } as any);
      observation = await h.driver.observe();
      const confirm = observation.targets.find((t) => t.name === 'Confirm')!;
      expect(confirm).toBeTruthy();
      await h.driver.execute({ ...h.proposal(observation, { tool: 'browser.click', targetId: confirm.targetId, button: 'left', clickCount: 1 }), observation } as any);
      expect((await h.driver.probe({ kind: 'text_visible', text: 'Change applied' })).verdict).toBe('pass');
      const late = observation.targets.find((t) => t.name === 'Start loading')!;
      await h.driver.execute({ ...h.proposal(observation, { tool: 'browser.click', targetId: late.targetId, button: 'left', clickCount: 1 }), observation } as any);
      expect((await h.driver.probe({ kind: 'text_visible', text: 'Ready after delay' }, 3_000)).verdict).toBe('pass');
    } finally {
      await h.close();
    }
  });

  it('opens and switches to a new tab', async () => {
    const h = await harness('/newtab');
    try {
      const observation = await h.driver.observe();
      const link = observation.targets.find((t) => t.name.includes('Open a new tab'))!;
      await h.driver.execute({ ...h.proposal(observation, { tool: 'browser.click', targetId: link.targetId, button: 'left', clickCount: 1 }), observation } as any);
      await new Promise((r) => setTimeout(r, 500));
      const tabs = await h.driver.tabStates();
      expect(tabs.length).toBe(2);
      const opened = tabs.find((t) => t.url.includes('/opened'))!;
      expect(opened).toBeTruthy();
      await h.driver.execute({ ...h.proposal(observation, { tool: 'browser.switch_tab', tabId: opened.tabId }), observation } as any);
      const freshness = await h.driver.freshness();
      expect(freshness.url).toContain('/opened');
    } finally {
      await h.close();
    }
  });

  it('types Unicode through the keyboard, presses Enter and persists the result', async () => {
    const h = await harness('/');
    try {
      const observation = await h.driver.observe();
      const field = observation.targets.find((t) => t.role === 'textbox' && t.name === 'Project name')!;
      await h.driver.execute({ ...h.proposal(observation, { tool: 'browser.click', targetId: field.targetId, button: 'left', clickCount: 1 }), observation } as any);
      await h.driver.execute({ ...h.proposal(observation, { tool: 'browser.press', key: process.platform === 'darwin' ? 'Meta+A' : 'Control+A' }), observation } as any);
      await h.driver.execute({ ...h.proposal(observation, { tool: 'browser.type', text: '键盘Demo ✅' }), observation } as any);
      await h.driver.execute({ ...h.proposal(observation, { tool: 'browser.press', key: 'Enter' }), observation } as any);
      const deadline = Date.now() + 4_000;
      let name = '';
      while (Date.now() < deadline) {
        name = (await fixture.readData()).projects[0]!.name;
        if (name === '键盘Demo ✅') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(name).toBe('键盘Demo ✅');
    } finally {
      await h.close();
    }
  });

  it('rejects an action based on an observation from before navigation', async () => {
    const h = await harness('/');
    try {
      const old = await h.driver.observe();
      await h.driver.execute({ ...h.proposal(old, { tool: 'browser.navigate', url: `${fixture.url}/list` }), observation: old } as any);
      await expect(
        execute(h, old, { tool: 'browser.fill', targetId: old.targets.find((t) => t.role === 'textbox')!.targetId, value: 'Stale' }),
      ).rejects.toThrow(/re-observe/);
    } finally {
      await h.close();
    }
  });

  it('clicks a real button through screenshot coordinate conversion', async () => {
    const h = await harness('/');
    try {
      const observation = await h.driver.observe();
      const save = observation.targets.find((t) => t.name === 'Save')!;
      expect(save.bbox).toBeTruthy();
      const point = viewportToScreenshot(
        { x: save.bbox!.x + save.bbox!.width / 2, y: save.bbox!.y + save.bbox!.height / 2 },
        observation.screenshot as any,
      );
      const result = await execute(h, observation, { tool: 'browser.click', coordinate: point, button: 'left', clickCount: 1 });
      expect(result.result.status).toBe('succeeded');
      expect((await h.driver.probe({ kind: 'text_visible', text: 'Saved successfully' }, 4_000)).verdict).toBe('pass');
    } finally {
      await h.close();
    }
  });

  it('invalidates screenshot coordinates after an external scroll', async () => {
    const h = await harness('/iframe');
    try {
      const observation = await h.driver.observe();
      await h.driver.execute({ ...h.proposal(observation, { tool: 'browser.scroll', direction: 'down', amount: 3 }), observation } as any);
      await expect(
        execute(h, observation, { tool: 'browser.click', coordinate: [100, 100], button: 'left', clickCount: 1 }),
      ).rejects.toThrow(/scrolled/);
    } finally {
      await h.close();
    }
  });

  it('invalidates old references when controls reorder within the same document', async () => {
    const h = await harness('/');
    try {
      const old = await h.driver.observe();
      const save = old.targets.find((t) => t.name === 'Save')!;
      const page = (h.driver as any).tabs[0].page;
      await page.evaluate(() => {
        const row = document.querySelector('.row')!;
        row.prepend(document.getElementById('reload')!);
      });
      const current = await h.driver.observe();
      expect(current.generation).toBe(old.generation);
      expect(current.targets.some((t) => t.targetId === save.targetId)).toBe(false);
      await expect(h.driver.execute({ ...h.proposal(old, { tool: 'browser.click', targetId: save.targetId, button: 'left', clickCount: 1 }), observation: old } as any))
        .rejects.toMatchObject({ code: 'TARGET_STALE' });
      expect(current.targets.find((t) => t.name === 'Save')).toBeTruthy();
    } finally {
      await h.close();
    }
  });

  it('does not follow a copied page reference to a replacement control', async () => {
    const h = await harness('/');
    try {
      const observation = await h.driver.observe();
      const save = observation.targets.find((t) => t.name === 'Save')!;
      const page = (h.driver as any).tabs[0].page;
      await page.evaluate(() => {
        const button = document.getElementById('save')!;
        const replacement = button.cloneNode(true) as HTMLElement;
        replacement.textContent = 'Unexpected recipient';
        replacement.onclick = (event) => { event.preventDefault(); document.body.dataset.wrongClick = 'yes'; };
        button.replaceWith(replacement);
      });
      await expect(h.driver.execute({ ...h.proposal(observation, { tool: 'browser.click', targetId: save.targetId, button: 'left', clickCount: 1 }), observation } as any))
        .rejects.toMatchObject({ code: 'TARGET_STALE' });
      expect(await page.evaluate(() => document.body.dataset.wrongClick)).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it('persists a real download and verifies the bytes and SHA-256 independently', async () => {
    const h = await harness('/');
    try {
      const observation = await h.driver.observe();
      const link = observation.targets.find((t) => t.name === 'Download project record')!;
      const result = await execute(h, observation, { tool: 'browser.click', targetId: link.targetId, button: 'left', clickCount: 1 }, [
        { kind: 'download', filename: 'project.txt', contains: 'Unicode: 你好 ✅', withinMs: 5_000 },
      ]);
      expect(result.result.status).toBe('succeeded');
      const [download] = h.driver.downloads();
      expect(download!.sourceUrl).toBe(`${fixture.url}/download/project.txt`);
      expect(download!.artifact.kind).toBe('download');
      const bytes = await readFile(download!.artifact.path);
      expect(bytes.toString('utf8')).toContain('Unicode: 你好 ✅');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(download!.artifact.sha256);
      expect((await h.driver.probe({ kind: 'download', filename: 'project.txt', sha256: '0'.repeat(64) })).verdict).toBe('fail');
      const verification = await new Verifier().verify({ task: h.task, driver: h.driver, scope: 'task', criteria: [
        { kind: 'download', filename: 'project.txt', sha256: download!.artifact.sha256, contains: 'Project export: Demo' },
      ] });
      expect(verification.verdict).toBe('pass');
      expect(verification.evidence.some((e) => e.ref === download!.artifact.path)).toBe(true);
    } finally { await h.close(); }
  });

  it('blocks unapproved navigation, fetch, image, popup, WebSocket and redirect destinations before any receiver request', async () => {
    let hits = 0;
    const receiver = createServer((_req, res) => { hits += 1; res.end('must not be reached'); });
    receiver.on('upgrade', (_req, socket) => { hits += 1; socket.destroy(); });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/forbidden`;
    const h = await harness('/');
    try {
      const page = (h.driver as any).tabs[0].page;
      await page.evaluate(async (destination: string) => {
        await fetch(destination, { mode: 'no-cors', method: 'POST', body: 'do-not-send' }).catch(() => undefined);
        const image = new Image(); image.src = destination; document.body.append(image);
        window.open(destination, '_blank');
        const ws = new WebSocket(destination.replace('http:', 'ws:'));
        await new Promise<void>((resolve) => { ws.onclose = () => resolve(); setTimeout(resolve, 200); });
      }, url);
      await page.goto(`${fixture.url}/redirect?to=${encodeURIComponent(url)}`).catch(() => undefined);
      await page.goto(url).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(hits).toBe(0);
    } finally {
      await h.close();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });

  it('loads recovery pages with scripts disabled and write requests blocked', async () => {
    await fixture.reset();
    const before = (await fixture.readData()).projects[0]!.name;
    const h = await harness('/auto-submit', { readOnlyNetwork: true, allowedOrigins: [fixture.url + '/a/path?query=1'] });
    try {
      expect((await h.driver.observe()).visibleText).toContain('Recovery fixture');
      const page = (h.driver as any).tabs[0].page;
      // DevTools evaluate is used only by this adversarial test; recovery never
      // executes model code. The request policy also blocks an explicit POST.
      await page.evaluate(async () => {
        await fetch('/api/projects/1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'UNEXPECTED_WRITE' }) }).catch(() => undefined);
      });
      expect((await fixture.readData()).projects[0]!.name).toBe(before);
    } finally { await h.close(); }
  });

  it('blocks new network requests after authorization expiry', async () => {
    const config = { allowedOrigins: [fixture.url], authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString() };
    const h = await harness('/', config);
    try {
      const page = (h.driver as any).tabs[0].page;
      config.authorizationExpiresAt = new Date(Date.now() - 1).toISOString();
      const result = await page.evaluate(async () => {
        try { await fetch('/api/projects/1'); return 'unexpectedly-allowed'; }
        catch { return 'blocked'; }
      });
      expect(result).toBe('blocked');
    } finally { await h.close(); }
  });
});
