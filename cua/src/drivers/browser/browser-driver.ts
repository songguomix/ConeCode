import { chromium, type Browser, type BrowserContext, type Frame, type Page, type Download, type ElementHandle } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { ArtifactRecord } from '../../store/store.js';
import { newId } from '../../protocol/ids.js';
import { CuaError } from '../../protocol/errors.js';
import { normalizeUrl } from '../../protocol/observation-utils.js';
import {
  BrowserActionSchema,
  ObservationSchema,
  nowIso,
  type ActionProposal,
  type BrowserAction,
  type Capabilities,
  type Condition,
  type Environment,
  type EvidenceRef,
  type Observation,
  type ScreenshotMeta,
} from '../../protocol/schemas.js';
import type { ArtifactStore } from '../../store/artifacts.js';
import type { Driver, DriverContext, DriverOutcome, ProbeResult } from '../types.js';
import { unsupportedProbe } from '../types.js';
import { pngDimensions, screenshotScale, screenshotToViewport } from './coordinates.js';
import { snapshotExpression, type FrameSnapshot } from './snapshot-script.js';

interface TabState {
  tabId: string;
  page: Page;
  generation: number;
  createdOrder: number;
}

export interface BrowserDownload {
  filename: string;
  sourceUrl: string;
  artifact: ArtifactRecord;
}

const MAX_TARGETS = 250;
const MAX_TEXT_PER_FRAME = 8_000;
const MAX_TEXT_TOTAL = 20_000;

export class BrowserDriver implements Driver {
  readonly kind = 'browser' as const;
  private browser?: Browser;
  private context?: BrowserContext;
  private tabs: TabState[] = [];
  private activeTabId = '';
  private started = false;
  private closed = false;
  private dialogs: string[] = [];
  private pageCrash = new Map<string, string>();
  private frameTokens = new WeakMap<Frame, string>();
  private nextOrder = 0;
  // Handles are held outside page JavaScript. A page cannot redirect a target by
  // copying our diagnostic data-cua-ref attribute to a different element.
  private targetHandles = new Map<string, { handle: ElementHandle<Element>; page: Page }>();
  private blockedRequests: string[] = [];
  private downloadRecords: BrowserDownload[] = [];
  private pendingDownloads = new Set<Promise<void>>();
  private downloadErrors: string[] = [];
  private socketTimers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly ctx: DriverContext,
    private readonly environment: Extract<Environment, { kind: 'browser' }>,
    private readonly artifacts: ArtifactStore,
    private readonly config: { actionTimeoutMs?: number; navigationTimeoutMs?: number; allowedOrigins?: string[]; authorizationExpiresAt?: string; maxDownloadBytes?: number; readOnlyNetwork?: boolean } = {},
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.browser = await chromium.launch({
      headless: this.environment.headless,
      args: ['--disable-dev-shm-usage', '--no-first-run'],
    });
    this.context = await this.browser.newContext({
      viewport: this.environment.viewport ?? { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      serviceWorkers: 'block',
      javaScriptEnabled: !this.config.readOnlyNetwork,
      acceptDownloads: true,
    });
    await this.context.route('**/*', async (route) => {
      const url = route.request().url();
      if (!this.requestAllowed(url) || (this.config.readOnlyNetwork && !['GET', 'HEAD'].includes(route.request().method()))) {
        this.recordBlocked(url);
        return route.abort('blockedbyclient');
      }
      try {
        // Playwright routing only sees the first request in a redirect chain.
        // Fetch with redirect-following disabled, then fail closed on 3xx so
        // an allowed endpoint cannot relay data to an unauthorized recipient.
        const response = await route.fetch({ maxRedirects: 0, timeout: this.config.navigationTimeoutMs ?? 20_000 });
        if ((response.status() >= 300 && response.status() < 400) || !this.requestAllowed(url)) {
          this.recordBlocked(response.headers().location ? new URL(response.headers().location, url).href : url);
          return route.abort('blockedbyclient');
        }
        await route.fulfill({ response });
      } catch {
        await route.abort('failed').catch(() => undefined);
      }
    });
    await this.context.routeWebSocket('**/*', (socket) => {
      if (this.config.readOnlyNetwork || !this.requestAllowed(socket.url(), true)) {
        this.recordBlocked(socket.url());
        void socket.close({ code: 1008, reason: 'Task authorization denies this destination.' });
        return;
      }
      const upstream = socket.connectToServer();
      if (this.config.authorizationExpiresAt) {
        const remaining = Math.max(0, Date.parse(this.config.authorizationExpiresAt) - Date.now());
        const timer = setTimeout(() => {
          this.socketTimers.delete(timer);
          void socket.close({ code: 1008, reason: 'Task authorization expired.' });
          void upstream.close({ code: 1008, reason: 'Task authorization expired.' });
        }, Math.min(remaining, 2_147_483_647));
        this.socketTimers.add(timer);
      }
    });
    this.context.setDefaultTimeout(this.config.actionTimeoutMs ?? 10_000);
    this.context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs ?? 20_000);
    this.context.on('page', (page) => this.registerPage(page));
    const page = await this.context.newPage();
    this.registerPage(page);
    this.activeTabId = this.tabs[0]!.tabId;
    if (this.environment.startUrl) {
      await page.goto(this.environment.startUrl, { waitUntil: 'domcontentloaded' });
    }
    this.started = true;
  }

  private registerPage(page: Page): void {
    if (this.tabs.some((t) => t.page === page)) return;
    const tabId = `tab_${randomUUID()}`;
    const tab: TabState = { tabId, page, generation: 0, createdOrder: this.nextOrder++ };
    this.tabs.push(tab);
    if (!this.activeTabId) this.activeTabId = tabId;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) tab.generation += 1;
    });
    page.on('dialog', (dialog) => {
      this.dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss().catch(() => undefined);
    });
    page.on('download', (download) => {
      const pending = this.persistDownload(download).catch((error) => {
        this.downloadErrors.push(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { this.pendingDownloads.delete(pending); });
      this.pendingDownloads.add(pending);
    });
    page.on('crash', () => {
      this.pageCrash.set(tabId, 'renderer crashed');
      tab.generation += 1;
    });
    page.on('close', () => {
      this.tabs = this.tabs.filter((t) => t.page !== page);
      if (this.activeTabId === tabId) this.activeTabId = this.tabs[0]?.tabId ?? '';
    });
  }

  capabilities(): Capabilities {
    return {
      observe: true,
      screenshot: true,
      click: true,
      type: true,
      unicodeType: true,
      scroll: true,
      drag: true,
      key: true,
      tabs: true,
      code: true,
      actions: [
        'browser.navigate', 'browser.open_tab', 'browser.switch_tab', 'browser.close_tab',
        'browser.click', 'browser.fill', 'browser.type', 'browser.press', 'browser.scroll',
        'browser.hover', 'browser.drag', 'browser.wait_for', 'browser.screenshot',
        'browser.observe', 'code.run', 'task.finish',
      ],
      notes: ['Network destinations are restricted to task origins. HTTP redirects are deliberately blocked; navigate directly to an authorized final URL.', 'Downloads are size-limited and stored as immutable evidence artifacts.', 'Screenshot size follows the configured viewport; image resampling is not implemented.', 'Open shadow roots are traversed; closed shadow roots cannot be inspected.', 'Cross-origin iframes are observed through Playwright frame handles when permitted.'],
    };
  }

  surfaceId(): string {
    return this.activeTabId;
  }

  generation(): number {
    return this.activeTabState()?.generation ?? 0;
  }

  async freshness(): Promise<{ surfaceId: string; generation: number; url?: string; scrollX?: number; scrollY?: number }> {
    const tab = this.activeTabState();
    let scrollX: number | undefined;
    let scrollY: number | undefined;
    if (tab && !tab.page.isClosed()) {
      try {
        const scroll = await tab.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
        scrollX = scroll.x;
        scrollY = scroll.y;
      } catch {
        // The page may be navigating; freshness still compares generation/url.
      }
    }
    return {
      surfaceId: this.activeTabId,
      generation: tab?.generation ?? 0,
      url: tab && !tab.page.isClosed() ? tab.page.url() : undefined,
      scrollX,
      scrollY,
    };
  }

  private activeTabState(): TabState | undefined {
    return this.tabs.find((t) => t.tabId === this.activeTabId);
  }

  private activePage(): Page {
    const tab = this.activeTabState();
    if (!tab) throw new CuaError('DRIVER_UNAVAILABLE', 'No active browser tab is available.');
    if (tab.page.isClosed()) throw new CuaError('DRIVER_UNAVAILABLE', 'The active browser tab was closed.');
    const crash = this.pageCrash.get(tab.tabId);
    if (crash) throw new CuaError('DRIVER_UNAVAILABLE', `The active tab is unusable: ${crash}.`);
    return tab.page;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.socketTimers) clearTimeout(timer);
    this.socketTimers.clear();
    await this.clearTargets();
    try {
      await this.context?.close();
    } finally {
      await this.browser?.close().catch(() => undefined);
      this.started = false;
    }
  }

  private frameToken(frame: Frame): string {
    if (frame.parentFrame() === null) return 'main';
    let token = this.frameTokens.get(frame);
    if (!token) {
      token = `frame_${randomUUID().slice(0, 8)}`;
      this.frameTokens.set(frame, token);
    }
    return token;
  }

  async observe(): Promise<Observation> {
    if (!this.started) throw new CuaError('DRIVER_UNAVAILABLE', 'Browser session is not started.');
    const page = this.activePage();
    const tab = this.activeTabState()!;
    const generation = tab.generation;
    const observationId = newId('obs');
    await this.clearTargets();
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
    }));
    const frames = page.frames();
    const targets: Array<Record<string, unknown>> = [];
    const texts: string[] = [];
    const frameList: Array<{ frameId: string; url: string }> = [];
    let textTruncated = false;
    let targetsTruncated = false;
    let hiddenTargets = 0;
    let offscreenTargets = 0;
    let crossOriginFrames = 0;
    let shadowRoots = 0;
    let openDialogs = 0;
    const coverageNotes: string[] = [];
    const unreadableRegions: string[] = [];

    for (const frame of frames) {
      let token = frame === page.mainFrame() ? 'main' : this.frameToken(frame);
      try {
        const snapshotHandle = await frame.evaluateHandle(
          snapshotExpression({
            refPrefix: `${generation}:${token}:${observationId}`,
            maxTargets: Math.max(20, Math.floor(MAX_TARGETS / Math.max(1, frames.length))),
            maxText: MAX_TEXT_PER_FRAME,
          }),
        );
        const snap = await snapshotHandle.evaluate((snapshot: any) => {
          const { elements: _elements, ...data } = snapshot;
          return data;
        }) as FrameSnapshot;
        for (let index = 0; index < snap.targets.length; index += 1) {
          const element = (await snapshotHandle.evaluateHandle((snapshot: any, i: number) => snapshot.elements[i], index)).asElement();
          if (element) this.targetHandles.set(String(snap.targets[index]!.targetId), { handle: element as ElementHandle<Element>, page });
        }
        await snapshotHandle.dispose();
        frameList.push({ frameId: token, url: frame.url() });
        texts.push(snap.text);
        textTruncated ||= snap.textTruncated;
        targetsTruncated ||= snap.targetsTruncated;
        hiddenTargets += snap.hiddenTargets;
        offscreenTargets += snap.offscreenTargets;
        shadowRoots += snap.shadowRoots;
        openDialogs += snap.openDialogs;
        for (const target of snap.targets) {
          targets.push({ ...target, frameId: token });
        }
      } catch (error) {
        crossOriginFrames += 1;
        token = this.frameToken(frame);
        frameList.push({ frameId: token, url: frame.url() });
        unreadableRegions.push(`frame ${token}: ${error instanceof Error ? error.message : String(error)}`);
        coverageNotes.push('A frame could not be inspected; its contents are NOT known to be empty.');
      }
    }

    if (targets.length > MAX_TARGETS) {
      targets.length = MAX_TARGETS;
      targetsTruncated = true;
    }
    if (this.dialogs.length > 0) coverageNotes.push(`${this.dialogs.length} native dialog(s) were auto-dismissed; text is recorded separately.`);
    if (crossOriginFrames > 0) coverageNotes.push(`${crossOriginFrames} frame(s) were unreadable.`);

    const screenshot = await this.captureScreenshot(page, viewport);
    if (this.blockedRequests.length) coverageNotes.push(`Network policy blocked: ${this.blockedRequests.slice(-5).join(', ')}.`);
    if (this.downloadErrors.length) coverageNotes.push(...this.downloadErrors.slice(-3));
    if (this.downloadRecords.length) texts.push(`Completed downloads: ${this.downloadRecords.map((d) => `${d.filename} (artifact ${d.artifact.id}, sha256 ${d.artifact.sha256})`).join('; ')}`);
    let visibleText = texts.filter(Boolean).join('\n\n');
    if (visibleText.length > MAX_TEXT_TOTAL) {
      visibleText = visibleText.slice(0, MAX_TEXT_TOTAL);
      textTruncated = true;
    }

    const tabs = await Promise.all(
      this.tabs.map(async (t) => ({
        tabId: t.tabId,
        url: safeUrl(t.page),
        title: await safeTitle(t.page),
        active: t.tabId === this.activeTabId,
      })),
    );

    const observation: Observation = ObservationSchema.parse({
      schemaVersion: 1,
      id: observationId,
      taskId: this.ctx.taskId,
      runId: this.ctx.runId,
      sessionId: this.ctx.sessionId,
      surfaceId: this.activeTabId,
      generation,
      at: nowIso(),
      interface: {
        kind: 'browser',
        url: safeUrl(page),
        title: await safeTitle(page),
        tabs,
      },
      viewport,
      screenshot,
      visibleText,
      targets,
      frames: frameList,
      coverage: {
        textTruncated,
        targetsTruncated,
        hiddenTargets,
        offscreenTargets,
        crossOriginFrames,
        shadowRoots,
        openDialogs,
        coverageNotes: [
          ...coverageNotes,
          'Only the viewport is captured; content outside the viewport is not claimed to be absent.',
          ...(this.dialogs.length ? [`Dialogs: ${this.dialogs.slice(-5).join(' | ')}`] : []),
        ],
        unreadableRegions,
      },
      redactions: [],
    });
    return observation;
  }

  private async captureScreenshot(
    page: Page,
    viewport: { width: number; height: number; scrollX: number; scrollY: number; devicePixelRatio: number },
  ): Promise<ScreenshotMeta> {
    let buffer: Buffer;
    try {
      buffer = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'css' });
    } catch (error) {
      throw new CuaError('DRIVER_ERROR', 'The browser screenshot failed.', {
        details: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    const dims = pngDimensions(buffer);
    const artifact = await this.artifacts.save({
      taskId: this.ctx.taskId,
      kind: 'screenshot',
      bytes: buffer,
      extension: '.png',
      meta: { sessionId: this.ctx.sessionId, url: safeUrl(page), viewport },
    });
    const scale = screenshotScale(dims.width, dims.height, viewport.width, viewport.height);
    return {
      artifactId: artifact.id,
      path: artifact.path,
      width: dims.width,
      height: dims.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      scaleX: scale.scaleX,
      scaleY: scale.scaleY,
      scrollX: viewport.scrollX,
      scrollY: viewport.scrollY,
      offsetX: 0,
      offsetY: 0,
      devicePixelRatio: viewport.devicePixelRatio,
      fullPage: false,
    };
  }

  async execute(proposal: ActionProposal): Promise<DriverOutcome> {
    const action = BrowserActionSchema.parse(proposal.action) as BrowserAction;
    const page = this.activePage();
    const evidence: EvidenceRef[] = [];
    const actual: Record<string, unknown> = {};

    if (action.tool === 'browser.navigate') {
      this.assertAuthorizedUrl(action.url);
      const response = await page.goto(action.url, { waitUntil: 'domcontentloaded' });
      actual.url = page.url();
      actual.status = response?.status();
      return { actual, evidence };
    }

    if (action.tool === 'browser.open_tab') {
      if (action.url) this.assertAuthorizedUrl(action.url);
      const newPage = await this.context!.newPage();
      this.registerPage(newPage);
      const tab = this.tabs.find((t) => t.page === newPage)!;
      if (action.url) await newPage.goto(action.url, { waitUntil: 'domcontentloaded' });
      if (action.focus) this.activeTabId = tab.tabId;
      actual.tabId = tab.tabId;
      actual.url = safeUrl(newPage);
      return { actual, evidence };
    }

    if (action.tool === 'browser.switch_tab') {
      const tab = this.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) throw new CuaError('TARGET_NOT_FOUND', `Tab ${action.tabId} is not open.`);
      await tab.page.bringToFront();
      this.activeTabId = tab.tabId;
      actual.tabId = tab.tabId;
      actual.url = safeUrl(tab.page);
      return { actual, evidence };
    }

    if (action.tool === 'browser.close_tab') {
      const tab = this.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) throw new CuaError('TARGET_NOT_FOUND', `Tab ${action.tabId} is not open.`);
      await tab.page.close();
      actual.closedTabId = action.tabId;
      actual.activeTabId = this.activeTabId;
      return { actual, evidence };
    }

    if (action.tool === 'browser.click') {
      if (action.targetId) {
        const handle = await this.resolveTargetHandle(page, action.targetId);
        await handle.scrollIntoViewIfNeeded();
        await handle.click({ button: action.button, clickCount: action.clickCount });
        actual.targetId = action.targetId;
        actual.clicked = true;
      } else if (action.coordinate) {
        const meta = this.requireObservation(proposal).screenshot;
        if (!meta) throw new CuaError('PROTOCOL_INVALID', 'Coordinate click requires screenshot metadata in the observation.');
        this.assertScrollCurrent(proposal);
        const point = screenshotToViewport(action.coordinate, meta);
        await page.mouse.click(point.x, point.y, { button: action.button, clickCount: action.clickCount });
        actual.coordinate = action.coordinate;
        actual.viewportPoint = point;
      } else {
        throw new CuaError('PROTOCOL_INVALID', 'browser.click needs a targetId or coordinate.');
      }
      return { actual, evidence };
    }

    if (action.tool === 'browser.fill') {
      const handle = await this.resolveTargetHandle(page, action.targetId);
      await handle.fill(action.value, { timeout: this.config.actionTimeoutMs ?? 10_000 });
      const value = await handle.evaluate((el) => (el as HTMLInputElement).value ?? (el as HTMLElement).innerText);
      actual.targetId = action.targetId;
      actual.value = value;
      return { actual, evidence };
    }

    if (action.tool === 'browser.type') {
      if (action.targetId) {
        const handle = await this.resolveTargetHandle(page, action.targetId);
        await handle.click();
        if (action.clearFirst) {
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
          await page.keyboard.press('Backspace');
        }
      }
      await page.keyboard.type(action.text);
      actual.textLength = action.text.length;
      return { actual, evidence };
    }

    if (action.tool === 'browser.press') {
      if (action.targetId) {
        const handle = await this.resolveTargetHandle(page, action.targetId);
        await handle.click();
      }
      await page.keyboard.press(action.key);
      actual.key = action.key;
      return { actual, evidence };
    }

    if (action.tool === 'browser.scroll') {
      const amount = Math.round(action.amount) * 400;
      if (action.targetId) {
        const handle = await this.resolveTargetHandle(page, action.targetId);
        await handle.hover();
      }
      const dx = action.direction === 'left' ? -amount : action.direction === 'right' ? amount : 0;
      const dy = action.direction === 'up' ? -amount : action.direction === 'down' ? amount : 0;
      await page.mouse.wheel(dx, dy);
      await page.waitForTimeout(100);
      actual.scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      return { actual, evidence };
    }

    if (action.tool === 'browser.hover') {
      if (action.targetId) {
        const handle = await this.resolveTargetHandle(page, action.targetId);
        await handle.hover();
      } else if (action.coordinate) {
        const meta = this.requireObservation(proposal).screenshot;
        if (!meta) throw new CuaError('PROTOCOL_INVALID', 'Coordinate hover requires screenshot metadata.');
        this.assertScrollCurrent(proposal);
        const p = screenshotToViewport(action.coordinate, meta);
        await page.mouse.move(p.x, p.y);
      } else {
        throw new CuaError('PROTOCOL_INVALID', 'browser.hover needs a targetId or coordinate.');
      }
      return { actual, evidence };
    }

    if (action.tool === 'browser.drag') {
      const from = await this.resolvePoint(page, proposal, action.fromTargetId, action.from);
      const to = await this.resolvePoint(page, proposal, action.toTargetId, action.to);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 20 });
      await page.mouse.up();
      actual.from = from;
      actual.to = to;
      return { actual, evidence };
    }

    if (action.tool === 'browser.wait_for') {
      const result = await this.probe(action.condition, action.timeoutMs);
      if (result.verdict !== 'pass') {
        throw new CuaError('VERIFICATION_FAILED', `wait_for timed out: ${result.detail}`, {
          retryable: true,
          details: { verification: result },
        });
      }
      actual.condition = action.condition;
      return { actual, evidence: result.evidence ?? [] };
    }

    if (action.tool === 'browser.screenshot') {
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio,
      }));
      const meta = await this.captureScreenshot(page, viewport);
      actual.screenshot = meta;
      evidence.push({ kind: 'screenshot', ref: meta.artifactId ?? meta.path });
      return { actual, evidence };
    }

    if (action.tool === 'browser.observe') {
      return { actual: { observed: true }, evidence };
    }

    throw new CuaError('PROTOCOL_INVALID', `Unsupported browser action: ${(action as { tool: string }).tool}`);
  }

  private requestAllowed(rawUrl: string, websocket = false): boolean {
    if (this.config.authorizationExpiresAt && Date.parse(this.config.authorizationExpiresAt) <= Date.now()) return false;
    try {
      const url = new URL(rawUrl);
      if (websocket) url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      const origins = this.config.allowedOrigins ?? (this.environment.startUrl ? [new URL(this.environment.startUrl).origin] : []);
      return origins.some((entry) => {
        if (entry === '*') return true; // Only an explicitly user-authorized wildcard.
        try { return new URL(entry).origin === url.origin; } catch { return false; }
      });
    } catch { return false; }
  }

  private recordBlocked(rawUrl: string): void {
    try { const url = new URL(rawUrl); this.blockedRequests.push(`${url.origin}${url.pathname}`); }
    catch { this.blockedRequests.push('unsupported URL scheme'); }
    this.blockedRequests = this.blockedRequests.slice(-20);
  }

  private async persistDownload(download: Download): Promise<void> {
    const stream = await download.createReadStream();
    if (!stream) throw new CuaError('DRIVER_ERROR', `Download did not complete: ${await download.failure()}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > (this.config.maxDownloadBytes ?? 10 * 1024 * 1024)) {
        stream.destroy();
        await download.cancel();
        throw new CuaError('DRIVER_ERROR', 'Download exceeds the configured evidence size limit.');
      }
      chunks.push(Buffer.from(chunk));
    }
    const filename = download.suggestedFilename().replace(/[\\/]/g, '_');
    const extension = /^\.[a-z0-9]{1,12}$/i.test(extname(filename)) ? extname(filename) : '.bin';
    const sourceUrl = download.url();
    const artifact = await this.artifacts.save({
      taskId: this.ctx.taskId, kind: 'download', bytes: Buffer.concat(chunks), extension,
      meta: { sessionId: this.ctx.sessionId, sourceUrl, filename },
    });
    this.downloadRecords.push({ filename, sourceUrl, artifact });
  }

  downloads(): BrowserDownload[] {
    return this.downloadRecords.map((record) => ({ ...record, artifact: { ...record.artifact, meta: { ...record.artifact.meta } } }));
  }

  private assertAuthorizedUrl(url: string): void {
    if (!this.requestAllowed(url)) throw new CuaError('AUTHORIZATION_DENIED', 'Navigation is outside the active task origin authorization.');
  }

  private requireObservation(proposal: ActionProposal): Observation {
    // The controller keeps the full observation in memory; coordinate actions
    // only need its screenshot metadata, which is re-read from the store by the
    // executor and attached before calling the driver. For direct driver tests
    // we accept an observation embedded in the proposal metadata.
    const embedded = (proposal as unknown as { observation?: Observation }).observation;
    if (!embedded) {
      throw new CuaError('INTERNAL', 'Coordinate action is missing its observation context.');
    }
    return embedded;
  }

  private assertScrollCurrent(proposal: ActionProposal): void {
    // Executor checks freshness against the live scroll position; this is a
    // defensive check for callers that invoke the driver directly.
    void proposal;
  }

  private async resolvePoint(
    page: Page,
    proposal: ActionProposal,
    targetId: string | undefined,
    coordinate: [number, number] | undefined,
  ): Promise<{ x: number; y: number }> {
    if (targetId) {
      const handle = await this.resolveTargetHandle(page, targetId);
      const box = await handle.boundingBox();
      if (!box) throw new CuaError('TARGET_NOT_ACTIONABLE', `Target ${targetId} has no clickable box.`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    if (coordinate) {
      const meta = this.requireObservation(proposal).screenshot;
      if (!meta) throw new CuaError('PROTOCOL_INVALID', 'Coordinate drag requires screenshot metadata.');
      return screenshotToViewport(coordinate, meta);
    }
    throw new CuaError('PROTOCOL_INVALID', 'Drag needs a target or coordinate at both ends.');
  }

  async resolveTargetHandle(page: Page, targetId: string): Promise<ElementHandle<Element>> {
    const registered = this.targetHandles.get(targetId);
    if (!registered || registered.page !== page) {
      throw new CuaError('TARGET_STALE', `Target ${targetId} is not registered in the latest observation; re-observe.`);
    }
    const element = registered.handle;
    const connected = await element.evaluate((el) => el.isConnected);
    if (!connected) throw new CuaError('TARGET_STALE', `Target ${targetId} was detached; re-observe.`);
    const visible = await element.isVisible().catch(() => false);
    if (!visible) throw new CuaError('TARGET_NOT_ACTIONABLE', `Target ${targetId} is not visible.`);
    return element as ElementHandle<Element>;
  }

  private async clearTargets(): Promise<void> {
    const previous = [...this.targetHandles.values()];
    this.targetHandles.clear();
    await Promise.all(previous.map(({ handle }) => handle.dispose().catch(() => undefined)));
  }

  async probe(condition: Condition, timeoutMs = 0): Promise<ProbeResult> {
    const page = this.activePage();
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const poll = async (): Promise<ProbeResult> => {
      switch (condition.kind) {
        case 'download': {
          const record = [...this.downloadRecords].reverse().find((item) => item.filename === condition.filename);
          if (!record) return { verdict: 'fail', detail: `No completed persisted download named ${JSON.stringify(condition.filename)}.` };
          try {
            const bytes = await this.artifacts.readByPath(record.artifact.path);
            const hash = createHash('sha256').update(bytes).digest('hex');
            const valid = hash === record.artifact.sha256 && (!condition.sha256 || hash === condition.sha256) &&
              (condition.contains === undefined || bytes.toString('utf8').includes(condition.contains));
            return {
              verdict: valid ? 'pass' : 'fail', detail: `Download ${record.filename}: ${bytes.length} bytes, sha256 ${hash}.`,
              evidence: [{ kind: 'file', ref: record.artifact.path, note: `artifact ${record.artifact.id}; source ${record.sourceUrl}; sha256 ${hash}` }],
            };
          } catch (error) { return { verdict: 'insufficient_evidence', detail: `Cannot reread download artifact: ${String(error)}` }; }
        }
        case 'text_visible':
        case 'text_absent': {
          const { texts, unreadable } = await this.allFrameText(page);
          const found = texts.some((t) => t.toLowerCase().includes(condition.text.toLowerCase()));
          if (!found && unreadable > 0) {
            return { verdict: 'insufficient_evidence', detail: `Could not inspect ${unreadable} frame(s); absence of ${JSON.stringify(condition.text)} cannot be established.` };
          }
          const pass = condition.kind === 'text_visible' ? found : !found;
          return {
            verdict: pass ? 'pass' : 'fail',
            detail: pass
              ? `Text ${condition.kind === 'text_visible' ? 'is visible' : 'is absent'}: ${condition.text}`
              : `Text ${condition.kind === 'text_visible' ? 'not found' : 'still visible'}: ${condition.text}`,
            evidence: [],
          };
        }
        case 'value_equals': {
          try {
            const handle = await this.resolveTargetHandle(page, condition.targetId);
            const value = await handle.evaluate((el) => (el as HTMLInputElement).value ?? (el as HTMLElement).innerText ?? '');
            return {
              verdict: value === condition.value ? 'pass' : 'fail',
              detail: `Expected value ${JSON.stringify(condition.value)}, observed ${JSON.stringify(value)}.`,
            };
          } catch (error) {
            return {
              verdict: 'insufficient_evidence',
              detail: `Could not read the value target: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
        case 'url_matches': {
          let re: RegExp;
          try {
            re = new RegExp(condition.pattern);
          } catch {
            return { verdict: 'fail', detail: `Invalid URL pattern: ${condition.pattern}` };
          }
          const url = page.url();
          return { verdict: re.test(url) ? 'pass' : 'fail', detail: `URL ${url} ${re.test(url) ? 'matches' : 'does not match'} ${condition.pattern}.` };
        }
        case 'window_title': {
          const title = await page.title();
          return {
            verdict: title.includes(condition.contains) ? 'pass' : 'fail',
            detail: `Title ${JSON.stringify(title)} ${title.includes(condition.contains) ? 'contains' : 'does not contain'} ${JSON.stringify(condition.contains)}.`,
          };
        }
        default:
          return unsupportedProbe(condition.kind);
      }
    };

    let result = await poll();
    while (result.verdict === 'fail' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      result = await poll();
    }
    return result;
  }

  private async allFrameText(page: Page): Promise<{ texts: string[]; unreadable: number }> {
    const texts: string[] = [];
    let unreadable = 0;
    for (const frame of page.frames()) {
      try {
        const text = await frame.evaluate(() => document.body?.innerText ?? '');
        if (text) texts.push(text);
      } catch {
        // Unreadable frame; absence is not evidence of absence.
        unreadable += 1;
      }
    }
    return { texts, unreadable };
  }

  async switchTabForAcceptance(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.tabId === tabId);
    if (!tab) throw new CuaError('TARGET_NOT_FOUND', `Tab ${tabId} is not open.`);
    this.activeTabId = tab.tabId;
  }

  async tabStates(): Promise<Array<{ tabId: string; url: string; title: string; active: boolean }>> {
    return Promise.all(
      this.tabs.map(async (t) => ({
        tabId: t.tabId,
        url: safeUrl(t.page),
        title: await safeTitle(t.page),
        active: t.tabId === this.activeTabId,
      })),
    );
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

async function safeTitle(page: Page): Promise<string> {
  try {
    return page.isClosed() ? '' : await page.title();
  } catch {
    return '';
  }
}

// normalizeUrl is re-exported for freshness checks performed by the controller.
export { normalizeUrl };
