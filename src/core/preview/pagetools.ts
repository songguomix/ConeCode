// Lets the agent drive the page in the built-in browser at the DOM level,
// rather than by pointing at pixels.
//
// The split matters for how well this works in practice: the injected scripts
// stay deliberately dumb — they walk the DOM and hand back plain JSON — and all
// of the shaping happens here in TypeScript, where it can be tested without a
// browser. The page itself is untrusted, so nothing it returns is ever executed
// or trusted as a command; it is data that gets formatted into text for the model.
//
// Elements are addressed by ref (e1, e2, …) handed out by the last snapshot, not
// by selectors the model invents. A ref either resolves to the element that was
// described, or the call fails loudly and says the page moved on — which is the
// difference between a reliable loop and one that silently clicks the wrong thing.

/** One element in a page snapshot, as the injected script reports it. */
export interface PageNode {
  depth: number;
  /** ARIA-ish role: button, link, textbox, heading, text… */
  role: string;
  /** Accessible name, already trimmed by the injected side. */
  name?: string;
  /** Handle for click/fill. Only interactive nodes get one. */
  ref?: string;
  value?: string;
  /** checked / disabled / expanded / selected, as a compact list. */
  state?: string[];
  level?: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  nodes: PageNode[];
  /** Set when the walk hit the node cap, so the model knows it isn't the whole page. */
  truncated?: boolean;
}

export interface PageActionResult {
  ok: boolean;
  message: string;
  url?: string;
  title?: string;
}

/** Cap on nodes walked, so one pathological page can't eat the whole context. */
export const MAX_NODES = 400;
/** Cap on the rendered outline. Roughly a few thousand tokens at worst. */
export const MAX_SNAPSHOT_CHARS = 16000;

// ---- rendering -------------------------------------------------------------

/**
 * Render a snapshot as the indented outline the model reads. Compact on
 * purpose: this is sent on every look at the page, and the interesting content
 * is the roles, the names and the refs — not the markup around them.
 */
export function formatSnapshot(snapshot: PageSnapshot): string {
  const header = `Page: ${snapshot.title || '(untitled)'}\nURL: ${snapshot.url}`;
  if (snapshot.nodes.length === 0) {
    return `${header}\n\n(The page has no visible content. It may still be loading, or it may have failed to render — check page_console.)`;
  }

  const lines: string[] = [];
  for (const node of snapshot.nodes) {
    lines.push('  '.repeat(Math.min(node.depth, 12)) + '- ' + describeNode(node));
  }

  let body = lines.join('\n');
  let clipped = false;
  if (body.length > MAX_SNAPSHOT_CHARS) {
    body = body.slice(0, MAX_SNAPSHOT_CHARS);
    // Don't leave a half-written line at the cut.
    body = body.slice(0, body.lastIndexOf('\n'));
    clipped = true;
  }

  const note = snapshot.truncated || clipped
    ? '\n\n(Only part of the page is shown. Narrow it down with page_eval if you need something further in.)'
    : '';
  return `${header}\n\n${body}${note}`;
}

function describeNode(node: PageNode): string {
  const parts: string[] = [node.role];
  if (node.name) parts.push(JSON.stringify(node.name));
  if (node.level) parts.push(`level=${node.level}`);
  if (node.value !== undefined) parts.push(`value=${JSON.stringify(node.value)}`);
  if (node.state?.length) parts.push(node.state.join(' '));
  if (node.ref) parts.push(`[${node.ref}]`);
  return parts.join(' ');
}

// ---- injected scripts ------------------------------------------------------

// Everything below is source that runs *inside the previewed page*. It is
// wrapped in an IIFE returning JSON so executeJavaScript resolves with the
// result; the page has no preload and therefore no other channel back.

/** Shared helpers: visibility, accessible name, and the ref registry. */
const HELPERS = `
var REFS = (window.__conecodeRefs = window.__conecodeRefs || {});
// Two separate questions, deliberately. Only display/visibility/opacity really
// hide a subtree; a box with no size does not, and children can still paint
// outside it. Conflating the two meant a zero-width container — a backgrounded
// tab, a collapsed panel, a device frame mid-resize — reported the whole page as
// empty, which sends the agent off believing its work rendered nothing.
function hiddenSubtree(el) {
  if (!el || el.nodeType !== 1) return true;
  var tag = el.tagName.toLowerCase();
  if (tag === 'script' || tag === 'style' || tag === 'head' || tag === 'noscript' || tag === 'template') return true;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  var style = getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
}
// Laid out at all — not "big enough to see". getClientRects() survives a
// zero-width viewport, where getBoundingClientRect().width does not.
function laidOut(el) {
  return el.getClientRects().length > 0 || !!el.offsetParent || el === document.body;
}
function accessibleName(el) {
  var label = el.getAttribute('aria-label')
    || el.getAttribute('alt')
    || el.getAttribute('placeholder')
    || el.getAttribute('title');
  if (!label && el.id) {
    var forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (forLabel) label = forLabel.textContent;
  }
  if (!label) label = el.textContent;
  return (label || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
}
function roleOf(el) {
  var explicit = el.getAttribute('role');
  if (explicit) return explicit;
  var tag = el.tagName.toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'text';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    return 'textbox';
  }
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'img') return 'image';
  if (tag === 'li') return 'listitem';
  if (tag === 'table') return 'table';
  if (tag === 'form') return 'form';
  if (tag === 'nav') return 'navigation';
  return '';
}
function interactive(el) {
  var tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'input') return true;
  if (tag === 'a' && el.hasAttribute('href')) return true;
  if (el.hasAttribute('onclick') || el.isContentEditable) return true;
  var role = el.getAttribute('role');
  return role === 'button' || role === 'link' || role === 'checkbox' || role === 'tab' || role === 'menuitem';
}
function resolve(ref) { return REFS[ref] && REFS[ref].isConnected ? REFS[ref] : null; }
`;

/** Wrap a body so it always resolves with JSON and never rejects. */
function program(body: string): string {
  return `(function () {
  try {
    ${HELPERS}
    ${body}
  } catch (err) {
    return JSON.stringify({ ok: false, message: 'The page threw while handling this: ' + (err && err.message ? err.message : String(err)) });
  }
})()`;
}

/** Walk the page and hand back a ref-annotated outline. */
export function snapshotScript(): string {
  return program(`
    window.__conecodeRefs = {};
    REFS = window.__conecodeRefs;
    var nodes = [];
    var seq = 0;
    var truncated = false;

    function walk(el, depth) {
      if (nodes.length >= ${MAX_NODES}) { truncated = true; return; }
      if (hiddenSubtree(el)) return;
      var tag = el.tagName.toLowerCase();
      // Not laid out: don't describe it, but its children may still be, so keep going.
      if (!laidOut(el)) {
        for (var k = 0; k < el.children.length; k++) walk(el.children[k], depth);
        return;
      }

      var role = roleOf(el);
      var isInteractive = interactive(el);
      var childDepth = depth;

      if (role || isInteractive) {
        var node = { depth: depth, role: role || 'generic' };
        var name = accessibleName(el);
        // A container's textContent is every descendant's text; only report a
        // name where it actually names this element.
        if (name && (isInteractive || role === 'heading' || el.children.length === 0)) node.name = name;
        if (isInteractive) { seq++; var ref = 'e' + seq; REFS[ref] = el; node.ref = ref; }
        if (tag === 'input' || tag === 'textarea' || tag === 'select') node.value = String(el.value == null ? '' : el.value).slice(0, 200);
        if (/^h[1-6]$/.test(tag)) node.level = Number(tag[1]);
        var state = [];
        if (el.checked) state.push('checked');
        if (el.disabled) state.push('disabled');
        if (el.getAttribute('aria-expanded') === 'true') state.push('expanded');
        if (el.getAttribute('aria-selected') === 'true') state.push('selected');
        if (state.length) node.state = state;
        nodes.push(node);
        childDepth = depth + 1;
      } else if (el.children.length === 0) {
        // A leaf with nothing but words: report the words, they are the content.
        var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text) { nodes.push({ depth: depth, role: 'text', name: text.slice(0, 200) }); return; }
      }

      for (var i = 0; i < el.children.length; i++) walk(el.children[i], childDepth);
    }

    if (document.body) walk(document.body, 0);
    return JSON.stringify({
      ok: true, url: location.href, title: document.title, nodes: nodes, truncated: truncated,
    });
  `);
}

export function clickScript(ref: string): string {
  return program(`
    var el = resolve(${JSON.stringify(ref)});
    if (!el) return JSON.stringify({ ok: false, message: 'stale-ref' });
    el.scrollIntoView({ block: 'center', inline: 'center' });
    var label = accessibleName(el) || el.tagName.toLowerCase();
    el.click();
    return JSON.stringify({ ok: true, message: 'Clicked ' + JSON.stringify(label), url: location.href, title: document.title });
  `);
}

/**
 * Set a field's value. Assigning to `.value` is not enough on a React-style
 * controlled input: the framework tracks the last value it wrote and treats an
 * identical-looking assignment as no change, so the state never updates and the
 * agent sees its typing vanish. Going through the native setter and firing the
 * events the framework listens for is what actually works.
 */
export function fillScript(ref: string, text: string, submit: boolean): string {
  return program(`
    var el = resolve(${JSON.stringify(ref)});
    if (!el) return JSON.stringify({ ok: false, message: 'stale-ref' });
    el.scrollIntoView({ block: 'center' });
    el.focus();
    var value = ${JSON.stringify(text)};

    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    var submitted = false;
    if (${submit ? 'true' : 'false'}) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      if (el.form && typeof el.form.requestSubmit === 'function') { el.form.requestSubmit(); submitted = true; }
    }
    return JSON.stringify({
      ok: true,
      message: 'Filled ' + JSON.stringify(accessibleName(el) || el.tagName.toLowerCase()) + (submitted ? ' and submitted the form' : ''),
      url: location.href, title: document.title,
    });
  `);
}

/** Evaluate an expression in the page and stringify whatever comes back. */
export function evalScript(expression: string): string {
  return program(`
    var value = eval(${JSON.stringify(expression)});
    if (value && typeof value.then === 'function') return value.then(function (v) {
      return JSON.stringify({ ok: true, message: describe(v) });
    });
    function describe(v) {
      if (v === undefined) return 'undefined';
      if (v === null) return 'null';
      if (typeof v === 'string') return v;
      if (v instanceof Element) return v.outerHTML.slice(0, 2000);
      if (v instanceof NodeList || Array.isArray(v)) {
        return JSON.stringify(Array.prototype.slice.call(v, 0, 50).map(function (item) {
          return item instanceof Element ? item.outerHTML.slice(0, 300) : item;
        }), null, 2);
      }
      try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
    }
    return JSON.stringify({ ok: true, message: describe(value) });
  `);
}

// ---- result handling -------------------------------------------------------

/** What a ref failure should tell the model — it needs to re-look, not retry. */
export const STALE_REF_MESSAGE =
  'That element is no longer on the page — the refs from the last snapshot are out of date because the page changed. Call page_snapshot again and use the new refs.';

/**
 * Read back whatever the injected script resolved with. The page is untrusted,
 * so anything unparseable is reported as a failure rather than guessed at.
 */
export function parseActionResult(raw: unknown): PageActionResult {
  if (typeof raw !== 'string') {
    return { ok: false, message: 'The page returned nothing. It may have navigated away mid-action — take a fresh snapshot.' };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'The page returned something unreadable.' };
  }
  if (parsed?.ok !== true) {
    const message = parsed?.message === 'stale-ref' ? STALE_REF_MESSAGE : (parsed?.message || 'The action did not succeed.');
    return { ok: false, message };
  }
  return { ok: true, message: parsed.message ?? 'Done.', url: parsed.url, title: parsed.title };
}

/** Same, for a snapshot — which returns nodes rather than a message. */
export function parseSnapshot(raw: unknown): { ok: true; snapshot: PageSnapshot } | { ok: false; message: string } {
  const result = parseActionResult(raw);
  if (!result.ok) return { ok: false, message: result.message };
  try {
    const parsed = JSON.parse(raw as string);
    return {
      ok: true,
      snapshot: {
        url: parsed.url ?? '',
        title: parsed.title ?? '',
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        truncated: !!parsed.truncated,
      },
    };
  } catch {
    return { ok: false, message: 'The page returned an unreadable snapshot.' };
  }
}
