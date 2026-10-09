import { describe, expect, it, vi } from 'vitest';
import {
  normalizeWebUrl, isLocalHost, isLocalUrl,
  decodeDuckLink, parseDuckResults, parseLiteResults, formatResults,
  looksLikeJsShell, createTtlCache, htmlToText,
  stripTrackingParams, domainOf, cleanTitle, cleanSnippet,
  formatCompactResults, saveSearchRefs, resolveSearchRef, parseResultRef,
} from './policy';

describe('normalizeWebUrl (https-only policy)', () => {
  it('adds https when the scheme is missing', () => {
    expect(normalizeWebUrl('example.com/a')).toEqual({ ok: true, url: 'https://example.com/a', upgraded: false });
  });

  it('upgrades external http to https', () => {
    const r = normalizeWebUrl('http://example.com/a?b=1');
    expect(r).toEqual({ ok: true, url: 'https://example.com/a?b=1', upgraded: true });
  });

  it('keeps http for local dev servers', () => {
    for (const u of ['http://localhost:5173/', 'http://127.0.0.1:3000/x', 'http://[::1]:8080/']) {
      expect(normalizeWebUrl(u).ok).toBe(true);
      expect((normalizeWebUrl(u) as any).upgraded).toBe(false);
    }
  });

  it('rejects exotic schemes', () => {
    expect(normalizeWebUrl('file:///etc/passwd').ok).toBe(false);
    expect(normalizeWebUrl('data:text/html,hi').ok).toBe(false);
    expect(normalizeWebUrl('javascript:alert(1)').ok).toBe(false);
  });

  it('rejects empty and garbage input', () => {
    expect(normalizeWebUrl('').ok).toBe(false);
    expect(normalizeWebUrl('   ').ok).toBe(false);
  });
});

describe('isLocalHost / isLocalUrl', () => {
  it('recognises loopback forms', () => {
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('127.0.0.2')).toBe(true);
    expect(isLocalHost('::1')).toBe(true);
    expect(isLocalHost('app.local')).toBe(true);
    expect(isLocalHost('example.com')).toBe(false);
    expect(isLocalHost('localhost.evil.com')).toBe(false);
  });

  it('classifies full urls', () => {
    expect(isLocalUrl('http://localhost:5173/')).toBe(true);
    expect(isLocalUrl('https://example.com/')).toBe(false);
    expect(isLocalUrl('not a url')).toBe(false);
  });
});

const DUCK_HTML = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=abc">Example <b>Guide</b></a>
  <a class="result__snippet" href="https://example.com/guide">A practical guide to things.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://second.com/">Second result</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=abc">Example Guide</a>
</div>`;

describe('parseDuckResults', () => {
  it('extracts titles, decoded links and snippets, deduped', () => {
    const out = parseDuckResults(DUCK_HTML);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      title: 'Example Guide',
      link: 'https://example.com/guide',
      snippet: 'A practical guide to things.',
    });
    expect(out[1]).toEqual({ title: 'Second result', link: 'https://second.com/' });
  });

  it('decodes uddg links', () => {
    expect(decodeDuckLink('//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com%2Fa&rut=1')).toBe('https://x.com/a');
    expect(decodeDuckLink('https://plain.com/')).toBe('https://plain.com/');
  });

  it('returns nothing useful for empty pages', () => {
    expect(parseDuckResults('<html><body></body></html>')).toEqual([]);
  });
});

describe('parseLiteResults', () => {
  it('pulls direct https anchors and skips engine chrome', () => {
    const html = '<a href="https://duckduckgo.com/y.js">js</a>'
      + '<a href="https://a.com/1">First hit here</a>'
      + '<a href="https://b.com/2">Second hit here</a>'
      + '<a href="https://a.com/1">First hit here</a>';
    expect(parseLiteResults(html)).toEqual([
      { title: 'First hit here', link: 'https://a.com/1' },
      { title: 'Second hit here', link: 'https://b.com/2' },
    ]);
  });
});

describe('formatResults', () => {
  it('includes snippets when present', () => {
    const s = formatResults('q', [{ title: 'T', link: 'https://t.com', snippet: 'S' }]);
    expect(s).toContain('T');
    expect(s).toContain('https://t.com');
    expect(s).toContain('S');
  });

  it('reports empty searches', () => {
    expect(formatResults('q', [])).toContain('No web results');
  });
});

describe('looksLikeJsShell', () => {
  it('flags thin pages with framework markers', () => {
    expect(looksLikeJsShell('Loading…', '<div id="root"></div><script>__NEXT_DATA__</script>')).toBe(true);
    expect(looksLikeJsShell('Please enable JavaScript to continue.', '<html></html>')).toBe(true);
  });

  it('leaves real content alone', () => {
    expect(looksLikeJsShell('x'.repeat(2000), '<html></html>')).toBe(false);
    expect(looksLikeJsShell('A full article about rendering.', '<html><body>article</body></html>')).toBe(false);
  });
});

describe('createTtlCache', () => {
  it('hits, expires and evicts oldest-first', () => {
    vi.useFakeTimers();
    try {
      const c = createTtlCache<string>(2, 1000);
      c.set('a', '1');
      c.set('b', '2');
      expect(c.get('a')).toBe('1');
      c.set('c', '3'); // evicts b (a was refreshed)
      expect(c.get('b')).toBeUndefined();
      expect(c.size()).toBe(2);
      vi.advanceTimersByTime(1500);
      expect(c.get('a')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('htmlToText', () => {
  it('keeps paragraph breaks and decodes entities', () => {
    const out = htmlToText('<style>x</style><script>y</script><p>a &amp; b</p><p>c</p>');
    expect(out).toBe('a & b\n c');
  });
});

describe('stripTrackingParams / domainOf', () => {
  it('drops click trackers but keeps routing params and hash', () => {
    expect(stripTrackingParams('https://x.com/a?utm_source=g&page=2#sec'))
      .toBe('https://x.com/a?page=2#sec');
    expect(stripTrackingParams('https://x.com/a?fbclid=1&gclid=2')).toBe('https://x.com/a');
    expect(stripTrackingParams('not a url')).toBe('not a url');
  });

  it('returns bare hosts', () => {
    expect(domainOf('https://www.Example.com/path?q=1')).toBe('example.com');
    expect(domainOf('garbage')).toBe('');
  });
});

describe('cleanTitle', () => {
  it('drops a source suffix repeating the domain', () => {
    expect(cleanTitle('A Practical Guide | example.com', 'example.com')).toBe('A Practical Guide');
    expect(cleanTitle('A Practical Guide | other.com', 'example.com')).toBe('A Practical Guide | other.com');
  });

  it('caps long titles at a word boundary', () => {
    const t = cleanTitle('word '.repeat(40), 'x.com');
    expect(t.length).toBeLessThanOrEqual(91);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('cleanSnippet', () => {
  it('kills boilerplate', () => {
    expect(cleanSnippet('We value your privacy. Accept our cookies to continue.', 'T')).toBeNull();
    expect(cleanSnippet('Subscribe to our newsletter for more.', 'T')).toBeNull();
    expect(cleanSnippet('Skip to main content. Home.', 'T')).toBeNull();
    expect(cleanSnippet('too short', 'T')).toBeNull();
  });

  it('kills title echoes and keeps real signal', () => {
    expect(cleanSnippet('A practical guide to things', 'A Practical Guide to Things')).toBeNull();
    expect(cleanSnippet('Covers install, config and deploy with examples.', 'A Practical Guide')).toBe(
      'Covers install, config and deploy with examples.',
    );
  });

  it('caps at a word boundary', () => {
    const s = cleanSnippet('alpha '.repeat(60), 'Unrelated Title Here');
    expect(s!.length).toBeLessThanOrEqual(141);
    expect(s!.endsWith('…')).toBe(true);
  });
});

describe('formatCompactResults (token-cheap wire format)', () => {
  const hits = [
    { title: 'A Practical Guide | example.com', link: 'https://example.com/guide?utm_source=x', snippet: 'Covers install, config and deploy.' },
    { title: 'Second', link: 'https://second.com/', snippet: 'We use cookies to improve your experience.' },
  ];

  it('carries no URLs and de-junks snippets', () => {
    const out = formatCompactResults('q', hits);
    expect(out).not.toContain('https://');
    expect(out).not.toContain('http://');
    expect(out).toContain('1. A Practical Guide | example.com');
    expect(out).toContain('Covers install, config and deploy.');
    expect(out).not.toContain('cookies');
    expect(out).toContain('2. Second | second.com');
  });

  it('caps at six hits', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, link: `https://x${i}.com/` }));
    expect(formatCompactResults('q', many).split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(6);
  });

  it('is dramatically smaller than the old verbose format', () => {
    // Realistic hits: long tracking URLs + full 220-char snippets, as the
    // old format emitted them.
    const realistic = Array.from({ length: 8 }, (_, i) => ({
      title: `How to configure thing ${i} properly | docs.example.com`,
      link: `https://docs.example.com/guides/thing-${i}?utm_source=google&utm_medium=cpc&fbclid=abc`,
      snippet: 'This comprehensive step-by-step tutorial walks through every configuration option in detail, covering installation prerequisites, environment setup, advanced tuning parameters and troubleshooting common errors you may hit. '.slice(0, 220),
    }));
    const verbose = formatResults('how to configure thing', realistic);
    const compact = formatCompactResults('how to configure thing', realistic);
    expect(compact.length).toBeLessThan(verbose.length / 2);
  });
});

describe('search refs ("#N")', () => {
  it('parses ref syntax and rejects real input', () => {
    expect(parseResultRef('#3')).toBe(3);
    expect(parseResultRef('2')).toBe(2);
    expect(parseResultRef('https://x.com/')).toBeNull();
    expect(parseResultRef('#0')).toBeNull();
    expect(parseResultRef('#9')).toBeNull();
    expect(parseResultRef('3000')).toBeNull();
  });

  it('resolves per conversation scope', () => {
    saveSearchRefs('c1', [{ title: 'A', link: 'https://a.com/' }]);
    saveSearchRefs('c2', [{ title: 'B', link: 'https://b.com/' }]);
    expect(resolveSearchRef('c1', 1)).toEqual({ ok: true, url: 'https://a.com/' });
    expect(resolveSearchRef('c2', 1)).toEqual({ ok: true, url: 'https://b.com/' });
    expect(resolveSearchRef('c1', 2).ok).toBe(false);
    expect(resolveSearchRef('nobody', 1).ok).toBe(false);
  });
});
