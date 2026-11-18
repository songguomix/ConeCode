import { expect, it, vi } from 'vitest';
import { createDomainLookup, reviewSearch, testVirusTotalKey } from './aegis';

it('looks up only the domain, shares duplicate lookups and blocks malicious reports', async () => {
  const request = vi.fn(async () => Response.json({ data: { attributes: { last_analysis_stats: { malicious: 1 } } } }));
  const { results } = await reviewSearch(['https://github.com/a?q=private', 'https://github.com/b', 'http://localhost'], 'test', createDomainLookup(request, 0));
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('https://www.virustotal.com/api/v3/domains/github.com', expect.objectContaining({ redirect: 'error' }));
  expect(results.map(item => item.decision)).toEqual(['block', 'block', 'block']);
});

it('preserves offline review and backs off on quota errors', async () => {
  const request = vi.fn(async () => new Response(null, { status: 429 }));
  const lookup = createDomainLookup(request, 0);
  expect((await reviewSearch(['github.com'], '', lookup)).results[0]).toEqual({ decision: 'allow', vt: 'offline' });
  expect(request).not.toHaveBeenCalled();
  const report = await reviewSearch(['github.com', 'google.com'], 'test', lookup);
  expect(report.results.map(item => item.vt)).toEqual(['unavailable', 'unavailable']);
  expect(report.results.every(item => item.decision === 'review')).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([
  [200, 'connected'], [401, 'invalid'], [403, 'forbidden'], [429, 'limited'], [503, 'unavailable'],
] as const)('checks the supplied key against a live domain endpoint (HTTP %i)', async (status, expected) => {
  const request = vi.fn(async () => Response.json({ data: { type: 'domain' } }, { status }));
  expect(await testVirusTotalKey(' draft-key ', request)).toBe(expected);
  expect(request).toHaveBeenCalledWith('https://www.virustotal.com/api/v3/domains/virustotal.com',
    expect.objectContaining({ headers: { 'x-apikey': 'draft-key', Accept: 'application/json' } }));
});
