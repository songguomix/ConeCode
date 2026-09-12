import { describe, it, expect } from 'vitest';
import {
  formatSnapshot, parseSnapshot, parseActionResult,
  snapshotScript, clickScript, fillScript, evalScript,
  STALE_REF_MESSAGE, MAX_SNAPSHOT_CHARS,
  type PageSnapshot,
} from './pagetools';

const snapshot = (nodes: PageSnapshot['nodes'], extra: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url: 'http://localhost:5173/', title: 'Todo', nodes, ...extra,
});

describe('formatSnapshot', () => {
  it('renders an outline the model can point at', () => {
    const text = formatSnapshot(snapshot([
      { depth: 0, role: 'heading', name: 'Todo', level: 1 },
      { depth: 0, role: 'textbox', name: 'New task', ref: 'e1', value: '' },
      { depth: 0, role: 'button', name: 'Add', ref: 'e2' },
    ]));
    expect(text).toContain('Page: Todo');
    expect(text).toContain('URL: http://localhost:5173/');
    expect(text).toContain('- heading "Todo" level=1');
    expect(text).toContain('- textbox "New task" value="" [e1]');
    expect(text).toContain('- button "Add" [e2]');
  });

  it('indents by depth so nesting is readable', () => {
    const text = formatSnapshot(snapshot([
      { depth: 0, role: 'list' },
      { depth: 1, role: 'listitem', name: 'Buy milk' },
      { depth: 2, role: 'button', name: 'Delete', ref: 'e1' },
    ]));
    const lines = text.split('\n');
    expect(lines.find((l) => l.includes('listitem'))).toMatch(/^ {2}- /);
    expect(lines.find((l) => l.includes('button'))).toMatch(/^ {4}- /);
  });

  it('shows state flags', () => {
    const text = formatSnapshot(snapshot([
      { depth: 0, role: 'checkbox', name: 'Done', ref: 'e1', state: ['checked'] },
      { depth: 0, role: 'button', name: 'Save', ref: 'e2', state: ['disabled'] },
    ]));
    expect(text).toContain('checked [e1]');
    expect(text).toContain('disabled [e2]');
  });

  it('says so plainly when the page rendered nothing', () => {
    const text = formatSnapshot(snapshot([]));
    expect(text).toContain('no visible content');
    expect(text).toContain('page_console');
  });

  it('caps a huge page and says it was cut, rather than flooding the context', () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => ({
      depth: 1, role: 'text', name: `row number ${i} with some padding text`,
    }));
    const text = formatSnapshot(snapshot(nodes));
    expect(text.length).toBeLessThan(MAX_SNAPSHOT_CHARS + 500);
    expect(text).toContain('Only part of the page');
  });

  it('never leaves a half-written line at the cut', () => {
    const nodes = Array.from({ length: 5000 }, () => ({ depth: 0, role: 'text', name: 'x'.repeat(60) }));
    const body = formatSnapshot(snapshot(nodes)).split('\n\n')[1];
    for (const line of body.split('\n')) expect(line.startsWith('- ') || line.startsWith(' ')).toBe(true);
  });

  it('flags a walk that hit the node cap', () => {
    expect(formatSnapshot(snapshot([{ depth: 0, role: 'text', name: 'a' }], { truncated: true })))
      .toContain('Only part of the page');
  });
});

describe('parseActionResult', () => {
  it('reads a success', () => {
    const raw = JSON.stringify({ ok: true, message: 'Clicked "Add"', url: 'http://x/', title: 'T' });
    expect(parseActionResult(raw)).toEqual({ ok: true, message: 'Clicked "Add"', url: 'http://x/', title: 'T' });
  });

  it('turns a stale ref into an instruction to look again, not to retry', () => {
    const result = parseActionResult(JSON.stringify({ ok: false, message: 'stale-ref' }));
    expect(result.ok).toBe(false);
    expect(result.message).toBe(STALE_REF_MESSAGE);
    expect(result.message).toContain('page_snapshot again');
  });

  it('does not trust an unparseable answer from the page', () => {
    expect(parseActionResult('<html>not json</html>').ok).toBe(false);
    expect(parseActionResult(undefined).ok).toBe(false);
    expect(parseActionResult(null).ok).toBe(false);
    expect(parseActionResult(42 as any).ok).toBe(false);
  });

  it('reports a page that threw', () => {
    const result = parseActionResult(JSON.stringify({ ok: false, message: 'The page threw while handling this: boom' }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('boom');
  });
});

describe('parseSnapshot', () => {
  it('recovers the nodes', () => {
    const raw = JSON.stringify({ ok: true, url: 'http://x/', title: 'T', nodes: [{ depth: 0, role: 'button' }] });
    const parsed = parseSnapshot(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.snapshot.nodes).toHaveLength(1);
      expect(parsed.snapshot.title).toBe('T');
    }
  });

  it('tolerates a snapshot with the nodes missing instead of crashing', () => {
    const parsed = parseSnapshot(JSON.stringify({ ok: true, url: 'http://x/' }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.snapshot.nodes).toEqual([]);
  });

  it('passes a failure through', () => {
    expect(parseSnapshot(JSON.stringify({ ok: false, message: 'stale-ref' })))
      .toEqual({ ok: false, message: STALE_REF_MESSAGE });
  });
});

describe('injected scripts', () => {
  // These run inside an untrusted page, so the one thing that must hold is that
  // values coming from the model are embedded as data and cannot become code.
  it('keeps a ref that tries to break out inert', () => {
    const payload = 'e1"); alert(1); //';
    const script = clickScript(payload);
    // Embedded as an escaped literal, so the quote can't close the string...
    expect(script).toContain(JSON.stringify(payload));
    // ...and the result still parses, which it would not if the payload had
    // escaped into code position. (Parsed, never run.)
    expect(() => new Function(script)).not.toThrow();
  });

  it('keeps every generated script parseable whatever the model passes in', () => {
    const payloads = ['"', "'", '`${alert(1)}`', '\\', '</script>', '\n});alert(1);({'];
    for (const payload of payloads) {
      expect(() => new Function(clickScript(payload)), payload).not.toThrow();
      expect(() => new Function(fillScript('e1', payload, true)), payload).not.toThrow();
      expect(() => new Function(evalScript(payload)), payload).not.toThrow();
    }
  });

  it('escapes fill text containing quotes, newlines and backslashes', () => {
    const nasty = 'he said "hi"\n\\end';
    expect(fillScript('e1', nasty, false)).toContain(JSON.stringify(nasty));
  });

  it('escapes an eval expression rather than splicing it raw', () => {
    const script = evalScript('document.title');
    expect(script).toContain(JSON.stringify('document.title'));
  });

  it('always returns a JSON string and never throws out of the IIFE', () => {
    for (const script of [snapshotScript(), clickScript('e1'), fillScript('e1', 'x', true), evalScript('1')]) {
      expect(script.startsWith('(function () {')).toBe(true);
      expect(script).toContain('catch (err)');
      expect(script).toContain('JSON.stringify');
    }
  });

  it('goes through the native value setter, which is what React-style inputs need', () => {
    const script = fillScript('e1', 'hello', false);
    expect(script).toContain('getOwnPropertyDescriptor');
    expect(script).toContain("dispatchEvent(new Event('input'");
    expect(script).toContain("dispatchEvent(new Event('change'");
  });

  it('does not let a zero-sized box prune the subtree under it', () => {
    // Regression: the walker used to skip any element whose rect had no width,
    // so a zero-width viewport (backgrounded tab, collapsed panel, device frame
    // mid-resize) made the whole page report as empty. Only display/visibility
    // may stop the descent; size may only stop the element being described.
    const script = snapshotScript();
    expect(script).toContain('hiddenSubtree');
    expect(script).toContain('laidOut');
    // The size test must be followed by a descent into the children, not a bare return.
    expect(script).toMatch(/if \(!laidOut\(el\)\) \{[\s\S]{0,200}walk\(el\.children/);
  });

  it('only submits when asked', () => {
    expect(fillScript('e1', 'x', true)).toContain('requestSubmit');
    expect(fillScript('e1', 'x', false)).toContain('if (false)');
  });
});
