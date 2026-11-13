import { createAegisEngine } from './engine/index.mjs';

export const MAX_SEARCH_URLS = 20;
const MAX_URL_BYTES = 2048;

function canonicalSearchUrl(input) {
  if (typeof input !== 'string' || input.length > MAX_URL_BYTES || /[\u0000-\u001f\u007f\\]/u.test(input)) return null;
  const text = input.trim();
  const absolute = /^https?:\/\/[^/?#]/iu.test(text);
  if (!absolute && !/^[^:/?#@\s]+(?:[/?#]|$)/u.test(text)) return null;

  const candidate = absolute ? text : `https://${text}`;
  const authority = candidate.slice(candidate.indexOf('://') + 3).split(/[/?#]/u, 1)[0];
  if (authority.includes('@')) return null;
  try {
    const url = new URL(candidate);
    if (url.username || url.password || (!absolute && !url.hostname.includes('.'))) return null;
    const canonical = url.href;
    return Buffer.byteLength(canonical, 'utf8') <= MAX_URL_BYTES ? canonical : null;
  } catch {
    return null;
  }
}

function invalidUrl() {
  return {
    url: null,
    hostname: '',
    decision: 'block',
    score: 0,
    reasons: [{ code: 'invalid_url', severity: 'critical', message: 'Expected an HTTP(S) URL or a domain without embedded credentials.' }],
  };
}

/** Create an independent batch reviewer. Importing this module does not start a service. */
export function createAegisSearch(options) {
  const engine = createAegisEngine(options);
  return {
    async scanSearchResults(urls) {
      if (!Array.isArray(urls)) throw new TypeError('Expected an array of search result URLs.');
      if (urls.length < 1 || urls.length > MAX_SEARCH_URLS) {
        throw new RangeError(`Expected 1–${MAX_SEARCH_URLS} search result URLs.`);
      }

      const candidates = Array.from(urls, canonicalSearchUrl);
      const valid = candidates.filter((url) => url !== null);
      const verdicts = valid.length ? await engine.review(valid) : [];
      let index = 0;
      const results = candidates.map((url) => (url === null ? invalidUrl() : verdicts[index++]));
      const counts = { allow: 0, review: 0, block: 0 };
      for (const { decision } of results) counts[decision]++;
      const decision = counts.block ? 'block' : counts.review ? 'review' : 'allow';
      const allowedUrls = results.filter((item) => item.decision === 'allow').map((item) => item.url);
      return { decision, total: results.length, ...counts, allowedUrls, results };
    },
  };
}

const defaultReviewer = createAegisSearch();
export const scanSearchResults = defaultReviewer.scanSearchResults;
