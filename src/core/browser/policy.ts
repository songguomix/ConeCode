/**
 * BrowserUse policy layer — pure functions, no Electron import at load time
 * (vitest imports these directly). Everything the headless browser and the
 * fetch fast-path agree on lives here:
 *
 *   - https enforcement (external http is upgraded, exotic schemes rejected,
 *     localhost keeps http for dev servers),
 *   - search-result parsing (titles + links + snippets),
 *   - JS-shell detection (when a fetched page needs real rendering),
 *   - a tiny TTL cache so repeated searches/fetches cost nothing.
 */

/** Hosts that are allowed to stay on plain http (local dev servers). */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return (
    h === 'localhost' ||
    h === '::1' ||
    h === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
    h.endsWith('.local') ||
    h === '0.0.0.0'
  );
}

export type NormalizedUrl =
  | { ok: true; url: string; upgraded: boolean }
  | { ok: false; error: string };

/**
 * Normalize a user/model-supplied address into something loadable.
 * Missing scheme becomes https. External http is upgraded to https
 * (https-only policy). Anything that is not http(s) is rejected.
 */
export function normalizeWebUrl(raw: string): NormalizedUrl {
  const value = (raw || '').trim();
  if (!value) return { ok: false, error: 'Empty URL.' };
  // Reject exotic schemes before URL parsing can be creative with them.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
    return { ok: false, error: `Only https URLs can be opened (got "${value.split(':')[0]}:").` };
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: `Could not parse URL "${value}".` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only https URLs can be opened.' };
  }
  if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname)) {
    parsed.protocol = 'https:';
    return { ok: true, url: parsed.toString(), upgraded: true };
  }
  return { ok: true, url: parsed.toString(), upgraded: false };
}

/** True when the URL points at this machine (dev server, preview). */
export function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isLocalHost(parsed.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTML → text (moved verbatim from electron/main.ts so both paths share it).
// ---------------------------------------------------------------------------

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Search results.
// ---------------------------------------------------------------------------

export interface WebResult {
  title: string;
  link: string;
  snippet?: string;
}

/** Decode a DuckDuckGo redirect link (`//duckduckgo.com/l/?uddg=<enc>&…`). */
export function decodeDuckLink(href: string): string {
  const m = href.match(/uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  return href;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse DuckDuckGo html-endpoint results, now WITH snippets
 * (`result__snippet` sits right after each `result__a` link). Cap `limit`.
 */
export function parseDuckResults(html: string, limit = 8): WebResult[] {
  const out: WebResult[] = [];
  // One result block: the title link, optionally followed by its snippet.
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>(?:[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(html)) && out.length < limit) {
    const link = stripTrackingParams(decodeDuckLink(m[1]));
    if (!/^https?:\/\//i.test(link) || seen.has(link)) continue;
    seen.add(link);
    const title = stripTags(m[2]);
    if (!title) continue;
    const snippet = m[3] ? stripTags(m[3]) : undefined;
    out.push(snippet ? { title, link, snippet } : { title, link });
  }
  return out;
}

/**
 * Parse the lite endpoint (`lite.duckduckgo.com/lite/`), which has no result
 * classes — just plain anchors with direct hrefs. Used by the headless-browser
 * search path because it renders in ~1s with no JavaScript.
 */
export function parseLiteResults(html: string, limit = 8): WebResult[] {
  const out: WebResult[] = [];
  const re = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(html)) && out.length < limit) {
    const link = stripTrackingParams(m[1]);
    // Skip the engine's own chrome (headers, "more results", etc.).
    if (/duckduckgo\.com/i.test(link) || seen.has(link)) continue;
    const title = stripTags(m[2]);
    if (!title || title.length < 3 || title.length > 200) continue;
    seen.add(link);
    out.push({ title, link });
  }
  return out;
}

export function formatResults(query: string, results: WebResult[]): string {
  if (!results.length) return `No web results for "${query}".`;
  const lines = results.map((r, i) =>
    r.snippet
      ? `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.snippet.slice(0, 220)}`
      : `${i + 1}. ${r.title}\n   ${r.link}`,
  );
  return `Web results for "${query}":\n\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Noise removal + ultra-compact results.
//
// Search output is the most token-sensitive text in the loop: it is long, it
// repeats (titles echo snippets, domains echo URLs), and most of it is SEO
// boilerplate the model never acts on. So the compact format carries NO urls
// at all — just a number, a cleaned title and a bare domain, plus a short
// de-junked snippet when it actually adds signal. The model opens a hit with
// "#N" (resolved server-side against the latest search of its conversation),
// which also makes the follow-up call tiny instead of re-pasting a long URL.
// ---------------------------------------------------------------------------

/** How many hits a search hands back (small = cheap; refine the query for more). */
export const MAX_SEARCH_RESULTS = 6;
/** Snippet budget per hit — enough to judge relevance, nothing more. */
const SNIPPET_BUDGET = 140;
/** Title budget per hit. */
const TITLE_BUDGET = 90;

/** Query-string params that only track the clicker — stripped everywhere. */
const TRACKING_PARAMS = /^(utm_.+|usg|fbclid|gclid|gclsrc|dclid|msclkid|mc_cid|mc_eid|igshid|ref_?|si|spm|scm)$/i;

/** Shorten a URL by dropping tracking params (hash kept — SPAs route on it). */
export function stripTrackingParams(link: string): string {
  try {
    const parsed = new URL(link);
    let dropped = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) {
        parsed.searchParams.delete(key);
        dropped = true;
      }
    }
    return dropped ? parsed.toString() : link;
  } catch {
    return link;
  }
}

/** Bare registrable host for display (`www.` trimmed, no scheme/path). */
export function domainOf(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Clean a result title: collapse whitespace, drop a trailing source suffix
 * that merely repeats the domain ("Guide | example.com" → "Guide"), cap.
 */
export function cleanTitle(title: string, domain = ''): string {
  let t = (title || '').replace(/\s+/g, ' ').trim();
  if (domain) {
    const d = domain.toLowerCase();
    t = t.replace(/\s*[|·»—–\-:]\s*([\w.-]+\.[a-z]{2,})\.?\s*$/i, (m, host) =>
      String(host).toLowerCase().replace(/^www\./, '') === d ? '' : m,
    ).trim();
  }
  if (t.length > TITLE_BUDGET) {
    t = t.slice(0, TITLE_BUDGET).replace(/\s+\S*$/, '') + '…';
  }
  return t;
}

// Boilerplate that fills snippets but never helps pick a result.
const JUNK_SNIPPET_PATTERNS = [
  /cookie|consent|gdpr|we value your privacy|privacy choices/i,
  /subscribe|newsletter|sign up for|sign in|log in|create an account|paywall|to continue reading/i,
  /skip to (main )?content|skip navigation|home about contact|all rights reserved/i,
  /share on (facebook|twitter|x)|follow us on|tweet this|pin it/i,
  /page not found|lorem ipsum/i,
];

const wordSet = (s: string): Set<string> =>
  new Set((s.toLowerCase().match(/[a-z0-9\u4e00-\u9fff]{2,}/g) || []));

/**
 * Clean a snippet for display. Returns null when it carries no signal:
 * boilerplate, a near-echo of the title, or too thin to judge relevance by.
 * Otherwise a word-boundary-capped single line.
 */
export function cleanSnippet(snippet: string | undefined, title: string): string | null {
  const s = (snippet || '').replace(/\s+/g, ' ').trim();
  if (s.length < 15) return null;
  if (JUNK_SNIPPET_PATTERNS.some((re) => re.test(s))) return null;
  const st = wordSet(title);
  const ss = wordSet(s);
  if (st.size >= 3 && ss.size > 0) {
    let overlap = 0;
    for (const w of ss) if (st.has(w)) overlap++;
    if (overlap / ss.size >= 0.7) return null; // snippet just repeats the title
  }
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  if (s.length > 20 && (norm(s).includes(norm(title)) || (norm(title).length > 20 && norm(title).includes(norm(s))))) {
    return null;
  }
  if (s.length <= SNIPPET_BUDGET) return s;
  return s.slice(0, SNIPPET_BUDGET).replace(/\s+\S*$/, '') + '…';
}

/**
 * The compact wire format. One hit = one line (`N. title | domain`) plus an
 * optional cleaned snippet line. No URLs — entering happens via "#N".
 */
export function formatCompactResults(query: string, results: WebResult[]): string {
  if (!results.length) return `No web results for "${query}".`;
  const lines: string[] = [];
  results.slice(0, MAX_SEARCH_RESULTS).forEach((r, i) => {
    const domain = domainOf(r.link);
    const title = cleanTitle(r.title, domain) || domain || 'Untitled';
    lines.push(`${i + 1}. ${title}${domain ? ` | ${domain}` : ''}`);
    const snippet = cleanSnippet(r.snippet, title);
    if (snippet) lines.push(`   ${snippet}`);
  });
  return `Web results for "${query}":\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Result refs — "#N" in a later web_fetch/page_navigate resolves server-side
// against the latest search of that conversation (each conversation has its
// own slot, so concurrent chats never steal each other's numbers).
// ---------------------------------------------------------------------------

const searchRefTables = new Map<string, WebResult[]>();

/** Remember a search's hits under its conversation scope. */
export function saveSearchRefs(scope: string | undefined, results: WebResult[]): void {
  searchRefTables.set(scope || '', results.slice(0, MAX_SEARCH_RESULTS));
  // Bound memory: scopes are conversations; keep the freshest few dozen.
  while (searchRefTables.size > 50) {
    const oldest = searchRefTables.keys().next().value;
    if (oldest === undefined) break;
    searchRefTables.delete(oldest);
  }
}

export type SearchRef =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** Resolve "#N" (or "N") against the scope's latest search. */
export function resolveSearchRef(scope: string | undefined, n: number): SearchRef {
  const table = searchRefTables.get(scope || '') || [];
  const hit = table[n - 1];
  if (!hit) {
    return {
      ok: false,
      error: table.length === 0
        ? `No result #${n} — run web_search first; numbers refer to its latest results.`
        : `Only ${table.length} result${table.length === 1 ? '' : 's'} in the latest search — #${n} is out of range.`,
    };
  }
  return { ok: true, url: hit.link };
}

/** A bare "#N"/"N" address is a result ref, not a URL. */
export function parseResultRef(input: string): number | null {
  const m = /^\s*#?(\d{1,2})\s*$/.exec(input || '');
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= MAX_SEARCH_RESULTS ? n : null;
}

// ---------------------------------------------------------------------------
// JS-shell detection: when the fast fetch got a shell, not content.
// ---------------------------------------------------------------------------

const JS_SHELL_MARKERS = [
  '__next_data__', '__nuxt__', '__vite__', 'enable javascript',
  'enable java-script', 'checking your browser', 'just a moment',
  'captcha', 'cf-challenge', 'requires javascript', 'javascript is disabled',
  'you need to enable javascript',
];

/**
 * The fetch returned 200 but the page is a shell that only a real browser
 * can fill in: thin visible text plus framework/challenge markers.
 */
export function looksLikeJsShell(text: string, rawHtml: string): boolean {
  if (text.length > 1200) return false;
  const hay = `${text}\n${rawHtml.slice(0, 20000)}`.toLowerCase();
  return JS_SHELL_MARKERS.some((marker) => hay.includes(marker));
}

// ---------------------------------------------------------------------------
// Tiny TTL cache — repeated searches/fetches within minutes cost nothing.
// ---------------------------------------------------------------------------

export interface TtlCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
  size(): number;
}

export function createTtlCache<T>(max = 50, ttlMs = 5 * 60 * 1000): TtlCache<T> {
  const map = new Map<string, { value: T; at: number }>();
  return {
    get(key: string): T | undefined {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at > ttlMs) {
        map.delete(key);
        return undefined;
      }
      // Refresh recency.
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key: string, value: T): void {
      map.delete(key);
      map.set(key, { value, at: Date.now() });
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    clear(): void {
      map.clear();
    },
    size(): number {
      return map.size;
    },
  };
}
