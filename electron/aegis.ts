import { scanSearchResults } from '../server/plugins/aegis-search/index.mjs';

type Status = 'clean' | 'malicious' | 'suspicious' | 'unknown' | 'unavailable' | 'offline' | 'skipped';

export async function testVirusTotalKey(key: string, request = fetch) {
  try {
    const response = await request('https://www.virustotal.com/api/v3/domains/virustotal.com', {
      headers: { 'x-apikey': key.trim(), Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return 'invalid';
    if (response.status === 403) return 'forbidden';
    if (response.status === 429) return 'limited';
    if (response.ok && (await response.json()).data?.type === 'domain') return 'connected';
  } catch {
    // Network failures and malformed reports cannot confirm access.
  }
  return 'unavailable';
}

export function createDomainLookup(request: typeof fetch, interval = 16_000) {
  const cache = new Map<string, { status: Status; expires: number }>();
  let queue = Promise.resolve();
  let nextRequest = 0;
  let retryAfter = 0;

  async function lookup(host: string, key: string): Promise<Status> {
    const hit = cache.get(host);
    if (hit && hit.expires > Date.now()) return hit.status;
    if (retryAfter > Date.now()) return 'unavailable';
    const delay = nextRequest - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    nextRequest = Date.now() + interval;
    try {
      const response = await request('https://www.virustotal.com/api/v3/domains/' + encodeURIComponent(host), {
        headers: { 'x-apikey': key, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 429) retryAfter = Date.now() + 60_000;
      if (!response.ok && response.status !== 404) return 'unavailable';
      let status: Status = 'unknown';
      if (response.ok) {
        const stats = (await response.json()).data?.attributes?.last_analysis_stats;
        if (stats?.malicious >= 1 || stats?.suspicious >= 3) status = 'malicious';
        else if (stats?.suspicious >= 1) status = 'suspicious';
        else if (stats?.harmless > 0 || stats?.undetected > 0) status = 'clean';
      }
      if (cache.size >= 4096) cache.delete(cache.keys().next().value!);
      cache.set(host, { status, expires: Date.now() + 6 * 3600_000 });
      return status;
    } catch {
      return 'unavailable';
    }
  }
  return (host: string, key: string) => {
    const result = queue.then(() => lookup(host, key));
    queue = result.then(() => {}, () => {});
    return result;
  };
}

export async function reviewSearch(urls: string[], key: string, lookup: ReturnType<typeof createDomainLookup>) {
  const local = await scanSearchResults(urls);
  const results = await Promise.all(local.results.map(async item => {
    const vt = item.decision === 'block' ? 'skipped' : key ? await lookup(item.hostname, key) : 'offline';
    let decision = item.decision;
    if (vt === 'malicious') decision = 'block';
    else if (vt === 'suspicious' || vt === 'unknown' || vt === 'unavailable') decision = 'review';
    return { decision, vt };
  }));
  return { results };
}
