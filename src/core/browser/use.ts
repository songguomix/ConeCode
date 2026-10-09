/**
 * Headless BrowserUse — the built-in browser for the open web.
 *
 * The preview panel's <webview> only exists for the local project; the agent
 * needs the same drive-the-page ability for any https URL (search results,
 * docs, JS-heavy pages) with no project open and no visible panel. This is a
 * single hidden Chromium window in the main process (zero new dependencies —
 * Electron already ships it), reused across calls:
 *
 *   web_search ──fetch fast path──▶ results (ms, ~0 tokens of overhead)
 *        │  empty / blocked
 *        └──▶ browserSearch: render DDG lite in Chromium, parse anchors
 *
 *   web_fetch ──fetch fast path──▶ text
 *        │  JS shell / failure
 *        └──▶ browserRead: render the page, return its rendered innerText
 *
 *   page_navigate/click/fill/… on external URLs ──▶ the same window, with
 *   ref-annotated snapshots (the page_* scripts from pagetools are reused, so
 *   refs behave exactly like the preview panel's).
 *
 * No `electron` import at load time — it is dynamically imported inside the
 * functions that need it, which keeps vitest (and the renderer bundle) happy.
 */

import {
  normalizeWebUrl, parseDuckResults, parseLiteResults,
  parseResultRef, resolveSearchRef,
  type WebResult,
} from './policy';
import {
  snapshotScript, parseSnapshot, formatSnapshot,
  clickScript, fillScript, evalScript, parseActionResult,
} from '../preview/pagetools';

type BrowserWindowLike = {
  isDestroyed: () => boolean;
  loadURL: (url: string) => Promise<void>;
  webContents: {
    isDestroyed: () => boolean;
    executeJavaScript: (code: string) => Promise<any>;
    reload: () => void;
    goBack: () => void;
    getURL: () => string;
    once: (event: string, fn: (...args: any[]) => void) => void;
    setWindowOpenHandler: (fn: (details: { url: string }) => { action: 'deny' | 'allow' }) => void;
  };
  on: (event: string, fn: () => void) => void;
  close: () => void;
};

let win: BrowserWindowLike | null = null;

async function electron(): Promise<any> {
  return import('electron');
}

async function ensureWindow(): Promise<BrowserWindowLike> {
  if (win && !win.isDestroyed()) return win;
  const { BrowserWindow } = await electron();
  const created: BrowserWindowLike = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    // Untrusted pages: no Node, sandboxed guest, no popups.
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.on('closed', () => {
    if (win === created) win = null;
  });
  win = created;
  return created;
}

/** Shut the hidden window down (app quit, or memory hygiene). */
export async function closeBrowserUse(): Promise<void> {
  try {
    if (win && !win.isDestroyed()) win.close();
  } catch {
    // Already gone — nothing to do.
  }
  win = null;
}

/** Is there a live headless session (an external page under agent control)? */
export function hasBrowserSession(): boolean {
  try {
    return !!win && !win.isDestroyed();
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Load a URL and wait until the DOM is usable. Resolves with the final URL
 * (after redirects); rejects on timeout or load failure.
 */
async function load(url: string, timeoutMs: number): Promise<{ win: BrowserWindowLike; finalUrl: string }> {
  const w = await ensureWindow();
  const done = new Promise<{ finalUrl: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out loading ${url}`)), timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      try {
        resolve({ finalUrl: w.webContents.getURL() || url });
      } catch (e) {
        reject(e);
      }
    };
    w.webContents.once('did-finish-load', finish);
    w.webContents.once('did-fail-load', (_e: any, code: number, desc: string) =>
      reject(new Error(`could not load ${url} (${desc || code})`)),
    );
    void w.loadURL(url).catch(reject);
  });
  const out = await done;
  // Let client JS settle (framework hydration) before reading.
  await delay(600);
  return { win: w, finalUrl: out.finalUrl };
}

async function guestText(w: BrowserWindowLike, maxChars = 20000): Promise<{ title: string; text: string }> {
  const raw = await w.webContents.executeJavaScript(
    'JSON.stringify({ title: document.title || "", text: (document.body ? document.body.innerText : "") || "" })',
  );
  try {
    const parsed = JSON.parse(typeof raw === 'string' ? raw : '{}');
    return {
      title: String(parsed.title || ''),
      text: String(parsed.text || '').replace(/[ \t]+/g, ' ').trim().slice(0, maxChars),
    };
  } catch {
    return { title: '', text: '' };
  }
}

async function guestHtml(w: BrowserWindowLike, maxChars = 500000): Promise<string> {
  const raw = await w.webContents.executeJavaScript('document.documentElement ? document.documentElement.outerHTML : ""');
  return String(raw || '').slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Search + read fallbacks (used when the fetch fast-path comes up empty).
// ---------------------------------------------------------------------------

/**
 * Render a search page in Chromium and parse results. Lite first (no JS, ~1s
 * to first paint); the full html endpoint (with snippets) as backup.
 */
export async function browserSearch(query: string, limit = 8): Promise<WebResult[]> {
  const lite = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const full = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  for (const [url, parse] of [
    [lite, parseLiteResults],
    [full, parseDuckResults],
  ] as const) {
    try {
      const { win: w } = await load(url, 20000);
      const html = await guestHtml(w);
      const results = parse(html, limit);
      if (results.length) return results;
    } catch {
      // Next candidate.
    }
  }
  return [];
}

export interface BrowserReadout {
  url: string;
  title: string;
  text: string;
}

/** Render a page and return its *rendered* text (post-JS). https-enforced. */
export async function browserRead(rawUrl: string): Promise<BrowserReadout> {
  const normalized = normalizeWebUrl(rawUrl);
  if (!normalized.ok) throw new Error(normalized.error);
  const { win: w, finalUrl } = await load(normalized.url, 25000);
  const { title, text } = await guestText(w);
  return { url: finalUrl, title, text };
}

// ---------------------------------------------------------------------------
// BrowserUse agent driving (page_* tools on external URLs).
// ---------------------------------------------------------------------------

export interface BrowserNav {
  ok: boolean;
  url?: string;
  title?: string;
  snapshot?: string;
  error?: string;
}

/**
 * Navigate the headless window and hand back a ref-annotated snapshot.
 * Accepts a full https URL or a "#N" ref into the scope's latest search.
 */
export async function browserNavigate(rawUrl: string, scope?: string, timeoutMs = 25000): Promise<BrowserNav> {
  let target = (rawUrl || '').trim();
  const ref = parseResultRef(target);
  if (ref !== null) {
    const resolved = resolveSearchRef(scope, ref);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    target = resolved.url;
  }
  const normalized = normalizeWebUrl(target);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  try {
    const { finalUrl } = await load(normalized.url, timeoutMs);
    const snap = await browserSnapshot();
    return { ok: true, url: finalUrl, snapshot: snap };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Current page as the same outline the preview panel produces. */
export async function browserSnapshot(): Promise<string> {
  if (!hasBrowserSession()) return 'No page is open in the built-in browser yet. Call page_navigate with an https URL first.';
  try {
    const raw = await win!.webContents.executeJavaScript(snapshotScript());
    const parsed = parseSnapshot(raw);
    return parsed.ok ? formatSnapshot(parsed.snapshot) : parsed.message;
  } catch (e: any) {
    return `The page could not be reached: ${e?.message || String(e)}. It may still be loading — try again.`;
  }
}

export async function browserClick(ref: string): Promise<string> {
  if (!hasBrowserSession()) return 'No page is open in the built-in browser yet. Call page_navigate with an https URL first.';
  try {
    const raw = await win!.webContents.executeJavaScript(clickScript(ref));
    const outcome = parseActionResult(raw);
    if (!outcome.ok) return outcome.message;
    await delay(500);
    return `${outcome.message}\n\n${await browserSnapshot()}`;
  } catch (e: any) {
    return `The page could not be reached: ${e?.message || String(e)}.`;
  }
}

export async function browserFill(ref: string, text: string, submit = false): Promise<string> {
  if (!hasBrowserSession()) return 'No page is open in the built-in browser yet. Call page_navigate with an https URL first.';
  try {
    const raw = await win!.webContents.executeJavaScript(fillScript(ref, text, submit));
    const outcome = parseActionResult(raw);
    if (!outcome.ok) return outcome.message;
    if (!submit) return outcome.message;
    await delay(500);
    return `${outcome.message}\n\n${await browserSnapshot()}`;
  } catch (e: any) {
    return `The page could not be reached: ${e?.message || String(e)}.`;
  }
}

export async function browserEval(expression: string): Promise<string> {
  if (!hasBrowserSession()) return 'No page is open in the built-in browser yet. Call page_navigate with an https URL first.';
  try {
    const raw = await win!.webContents.executeJavaScript(evalScript(expression));
    return parseActionResult(raw).message;
  } catch (e: any) {
    return `The page could not be reached: ${e?.message || String(e)}.`;
  }
}

export async function browserHistory(action: 'reload' | 'back'): Promise<string> {
  if (!hasBrowserSession()) return 'No page is open in the built-in browser yet. Call page_navigate with an https URL first.';
  try {
    if (action === 'reload') win!.webContents.reload();
    else win!.webContents.goBack();
    await delay(900);
    return `${action === 'reload' ? 'Reloaded' : 'Went back'}.\n\n${await browserSnapshot()}`;
  } catch (e: any) {
    return `The page could not be reached: ${e?.message || String(e)}.`;
  }
}
