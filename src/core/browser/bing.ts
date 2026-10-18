import { htmlToText, stripTrackingParams, type WebResult } from './policy';

export function bingSearchUrl(query: string): string {
  return `https://www.bing.com/search?q=${encodeURIComponent(query.trim())}&setlang=en-US`;
}

function destination(raw: string): string | null {
  try {
    let url = new URL(raw.replace(/&amp;/g, '&'), 'https://www.bing.com');
    if (url.hostname.endsWith('.bing.com') && url.pathname.startsWith('/ck/')) {
      const encoded = url.searchParams.get('u');
      if (!encoded?.startsWith('a1')) return null;
      const base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      url = new URL(new TextDecoder().decode(bytes));
    }
    if (!['https:', 'http:'].includes(url.protocol) || /(^|\.)bing\.com$/i.test(url.hostname)) return null;
    return stripTrackingParams(url.toString());
  } catch { return null; }
}

function searchText(html: string): string {
  return htmlToText(html)
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, value: string) => {
      const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : parseInt(value, 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : entity;
    })
    .replace(/&(?:ndash|mdash|hellip|middot);/gi, (entity) => ({
      '&ndash;': '–', '&mdash;': '—', '&hellip;': '…', '&middot;': '·',
    })[entity.toLowerCase()] || entity)
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
}

/** Stop at the matching list item, including nested sitelink lists. */
function resultBlock(html: string, start: number, end: number): string {
  const region = html.slice(start, end);
  let depth = 0;
  for (const tag of region.matchAll(/<\/?li\b[^>]*>/gi)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) return region.slice(0, tag.index! + tag[0].length);
  }
  return region;
}

/** Parse organic result headings only; skip ads, navigation and AI summaries. */
export function parseBingResults(html: string, limit = 6): WebResult[] {
  const starts = [...html.matchAll(/<li\b[^>]*class\s*=\s*(["'])[^"']*\bb_algo\b[^"']*\1[^>]*>/gi)];
  const results: WebResult[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < starts.length && results.length < limit; i++) {
    const block = resultBlock(html, starts[i].index!, starts[i + 1]?.index ?? html.length);
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1];
    if (!heading) continue;
    const anchor = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i.exec(heading);
    if (!anchor) continue;
    const link = destination(anchor[2]);
    const title = searchText(anchor[3]);
    if (!link || !title || seen.has(link)) continue;
    seen.add(link);
    const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1];
    const snippet = paragraph ? searchText(paragraph) : '';
    results.push(snippet ? { title, link, snippet } : { title, link });
  }
  return results;
}
