import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAegisSearch, MAX_SEARCH_URLS, scanSearchResults } from './index.mjs';

test('reviews a batch in input order and exposes only the exact allowed URLs', async () => {
  const allowedUrl = 'https://github.com/docs?q=test#intro';
  const blocked = 'https://git-hub.example/';
  const uncertain = 'https://unrelated-example.net/guide';
  const result = await scanSearchResults(['GitHub.com/docs?q=test#intro', uncertain, blocked]);

  assert.equal(result.total, 3);
  assert.equal(result.decision, 'block');
  assert.deepEqual([result.allow, result.review, result.block], [1, 1, 1]);
  assert.deepEqual(result.results.map(({ url, decision }) => [url, decision]), [
    [allowedUrl, 'allow'], [uncertain, 'review'], [blocked, 'block'],
  ]);
  assert.deepEqual(result.allowedUrls, [allowedUrl]);
  assert.ok(result.results[0].reasons.some(({ code }) => code === 'official_domain'));
  assert.ok(result.results[2].reasons.some(({ code }) => code === 'lookalike_domain'));
});

test('invalid candidates are blocked in place without echoing credentials or disrupting valid URLs', async () => {
  const result = await scanSearchResults([
    'https://user:private-test-string@github.com/', 'github.com', 'https:///github.com',
    'file:///etc/hosts', 'https://@github.com/', 'https://github.com/\nrest',
    `https://github.com/${'汉'.repeat(500)}`, null,
  ]);
  assert.equal(result.block, 7);
  assert.deepEqual(result.allowedUrls, ['https://github.com/']);
  assert.deepEqual(result.results.map(({ url }) => url), [null, 'https://github.com/', null, null, null, null, null, null]);
  assert.equal(result.results[0].reasons[0].code, 'invalid_url');
  assert.doesNotMatch(JSON.stringify(result), /private-test-string/);
});

test('rejects invalid batch sizes before review', async () => {
  await assert.rejects(scanSearchResults('https://github.com'), TypeError);
  await assert.rejects(scanSearchResults([]), RangeError);
  await assert.rejects(scanSearchResults(Array(MAX_SEARCH_URLS + 1).fill('https://github.com')), RangeError);
});

test('runs with no network and keeps operator policy scoped to its instance', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('The review must work offline'); });
  const reviewer = createAegisSearch({ denylist: ['github.com'] });
  const [configured, defaults] = await Promise.all([
    reviewer.scanSearchResults(['github.com']), scanSearchResults(['github.com']),
  ]);
  assert.equal(configured.decision, 'block');
  assert.equal(defaults.decision, 'allow');
  assert.equal(fetch.mock.callCount(), 0);
});
