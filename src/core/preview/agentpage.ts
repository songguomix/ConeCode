import {
  snapshotScript, clickScript, fillScript, evalScript,
  parseSnapshot, parseActionResult, formatSnapshot,
  type PageActionResult,
} from './pagetools';

// The agent's handle on the page in the built-in browser.
//
// The <webview> lives in the renderer and so does the agent loop, so this needs
// no IPC at all — the panel registers its live element here and the tool
// dispatch calls straight into it. What this module owns is the part that isn't
// a one-liner: waiting for the guest to actually be ready, letting a click's
// navigation settle before reporting, and turning every failure into something
// the model can act on instead of a stack trace.

/** The slice of Electron's <webview> the agent needs. */
export interface AgentWebview {
  executeJavaScript: (code: string) => Promise<any>;
  loadURL: (url: string) => Promise<void>;
  reload: () => void;
  goBack: () => void;
  getURL: () => string;
  isLoading?: () => boolean;
}

let active: AgentWebview | null = null;

/** The panel calls this as tabs mount, close and change. */
export function setAgentWebview(webview: AgentWebview | null): void {
  active = webview;
}

export function hasAgentWebview(): boolean {
  return active !== null;
}

const NO_PAGE =
  'No page is open in the built-in browser yet. Call page_navigate with a URL first — if the project has a dev server, page_navigate with no URL starts it and opens it.';

/** How long a click is given to finish navigating before we look at the page. */
const SETTLE_MS = 350;

async function run(code: string): Promise<{ ok: false; message: string } | { ok: true; raw: unknown }> {
  if (!active) return { ok: false, message: NO_PAGE };
  try {
    return { ok: true, raw: await active.executeJavaScript(code) };
  } catch (err: any) {
    // executeJavaScript rejects when the guest isn't ready or was torn down
    // mid-call; both mean "look again", not "the page said no".
    return { ok: false, message: `The page could not be reached: ${err?.message || String(err)}. It may still be loading — try again, or take a fresh snapshot.` };
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the page as a ref-annotated outline the model can point at. */
export async function pageSnapshot(): Promise<string> {
  const result = await run(snapshotScript());
  if (!result.ok) return result.message;

  const parsed = parseSnapshot(result.raw);
  return parsed.ok ? formatSnapshot(parsed.snapshot) : parsed.message;
}

/**
 * Click a ref from the last snapshot, then look again — a click usually changes
 * the page, and the refs it hands back are the ones that are still valid.
 */
export async function pageClick(ref: string): Promise<string> {
  const result = await run(clickScript(ref));
  if (!result.ok) return result.message;

  const outcome = parseActionResult(result.raw);
  if (!outcome.ok) return outcome.message;

  await delay(SETTLE_MS);
  return `${outcome.message}\n\n${await pageSnapshot()}`;
}

export async function pageFill(ref: string, text: string, submit = false): Promise<string> {
  const result = await run(fillScript(ref, text, submit));
  if (!result.ok) return result.message;

  const outcome = parseActionResult(result.raw);
  if (!outcome.ok) return outcome.message;

  if (!submit) return outcome.message;
  await delay(SETTLE_MS);
  return `${outcome.message}\n\n${await pageSnapshot()}`;
}

export async function pageEval(expression: string): Promise<string> {
  const result = await run(evalScript(expression));
  if (!result.ok) return result.message;

  const outcome: PageActionResult = parseActionResult(result.raw);
  return outcome.ok ? outcome.message : outcome.message;
}

/** Reload or go back. Navigating to a URL is handled by the caller (it may need
 *  to open the panel and start a server first). */
export async function pageHistory(action: 'reload' | 'back'): Promise<string> {
  if (!active) return NO_PAGE;
  if (action === 'reload') active.reload();
  else active.goBack();
  await delay(SETTLE_MS * 2);
  return `${action === 'reload' ? 'Reloaded' : 'Went back'}.\n\n${await pageSnapshot()}`;
}

/** Wait for the guest to finish loading, so the first snapshot isn't of a blank page. */
export async function waitForPage(timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!active) { await delay(120); continue; }
    try {
      const ready = await active.executeJavaScript('document.readyState');
      if (ready === 'complete' || ready === 'interactive') return;
    } catch {
      // Guest not attached yet.
    }
    await delay(120);
  }
}
