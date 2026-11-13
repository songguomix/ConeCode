import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAegisEngine } from './index.mjs';

test('checks official suffix boundaries, lookalikes and mixed script domain names locally', async () => {
  const { review } = createAegisEngine();
  const results = await review([
    'https://api.github.com./',
    'https://github.com.unrelated-example.net/',
    'https://xn--gthub-n2e.com/', // gіthub.com with a Cyrillic і
    'https://lettercase-example.xyz/',
  ]);
  assert.deepEqual(results.map(({ hostname, decision, score }) => [hostname, decision, score]), [
    ['api.github.com', 'allow', 72],
    ['github.com.unrelated-example.net', 'review', 42],
    ['xn--gthub-n2e.com', 'block', 0],
    ['lettercase-example.xyz', 'review', 39],
  ]);
  assert.ok(results[0].reasons.some(({ code }) => code === 'official_domain'));
  for (const expected of ['lookalike_domain', 'punycode', 'mixed_script']) {
    assert.ok(results[2].reasons.some(({ code }) => code === expected));
  }
  assert.ok(results[3].reasons.some(({ code }) => code === 'suspicious_tld'));
});

test('retains Aegis tri, strict and observe decisions and lets denylist win', async () => {
  const common = { allowlist: ['unrelated-example.net', 'github.com'], denylist: ['api.github.com'] };
  const urls = [
    'https://docs.unrelated-example.net/',
    'https://unrelated-example.net.invalid/',
    'https://api.github.com/',
    'https://secure-github-login.com/',
  ];
  const policies = {
    tri: ['allow', 'review', 'block', 'block'],
    strict: ['allow', 'block', 'block', 'block'],
    observe: ['allow', 'allow', 'block', 'review'],
  };
  for (const [policyMode, expected] of Object.entries(policies)) {
    const result = await createAegisEngine({ ...common, policyMode }).review(urls);
    assert.deepEqual(result.map(({ decision }) => decision), expected);
  }
});

test('blocks IP literals and local names even in observe mode or if listed', async () => {
  const { review } = createAegisEngine({ policyMode: 'observe', allowlist: ['127.0.0.1', 'home.arpa', 'app.local'] });
  const results = await review([
    'https://127.0.0.1/', 'https://[::1]/', 'https://8.8.8.8/',
    'https://router.home.arpa/', 'https://app.local/', 'https://localhost/', 'https://foo.localhost/',
    'https://github..com/', 'https://.github.com/',
  ]);
  assert.ok(results.every(({ decision, score }) => decision === 'block' && score === 0));
  assert.ok(results.slice(0, 7).every(({ url, reasons }) => url && reasons[0].code === 'local_or_literal'));
  assert.ok(results.slice(7).every(({ url, reasons }) => url === null && reasons[0].code === 'invalid_url'));
});
