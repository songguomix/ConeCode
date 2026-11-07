import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BrowserDriver } from '../drivers/browser/browser-driver.js';
import { startFixtureServer } from '../fixtures/web-app.js';
import { newId } from '../protocol/ids.js';
import { observationForModel } from '../protocol/observation-utils.js';
import { ArtifactStore } from '../store/artifacts.js';
import { SessionStore } from '../store/store.js';

/** Paired measurements of the SAME live observation; no model inference. */
export async function compareContext(options: { repeats?: number } = {}) {
  const repeats = options.repeats ?? 3;
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('repeats must be between 1 and 20');
  const dir = await mkdtemp(join(tmpdir(), 'cua-context-benchmark-'));
  const fixture = await startFixtureServer({ dataFile: join(dir, 'fixture.json') });
  const store = new SessionStore(':memory:');
  const artifacts = new ArtifactStore(join(dir, 'artifacts'), store);
  const samples: Array<{
    scenario: string; iteration: number; observationId: string;
    observationMs: number; fullChars: number; projectedChars: number;
    fullSerializationMs: number; projectionAndSerializationMs: number;
    observedTargets: number; projectedTargets: number; projectedCoverage: unknown;
    forcedTrimCoverage: unknown; screenshotBytes: number;
  }> = [];
  try {
    for (const [scenario, path] of [['form', '/'], ['list', '/list'], ['iframe', '/iframe']]) {
      const driver = new BrowserDriver(
        { taskId: newId('task'), runId: newId('run'), sessionId: newId('ses') },
        { kind: 'browser', startUrl: `${fixture.url}${path}`, profile: 'default', headless: true }, artifacts,
      );
      try {
        await driver.start();
        for (let iteration = 1; iteration <= repeats; iteration++) {
          const before = performance.now();
          const observation = await driver.observe();
          const observationMs = performance.now() - before;
          const fullStart = performance.now();
          const full = JSON.stringify(observation);
          const fullSerializationMs = performance.now() - fullStart;
          const projectedStart = performance.now();
          const projected = observationForModel(observation, 80, 6_000);
          const projectedJson = JSON.stringify(projected);
          const projectionAndSerializationMs = performance.now() - projectedStart;
          const forcedTrim = observationForModel(observation, 1, 48);
          const screenshotBytes = observation.screenshot?.path
            ? (await readFile(observation.screenshot.path)).length : 0;
          samples.push({
            scenario, iteration, observationId: observation.id, observationMs,
            fullChars: full.length, projectedChars: projectedJson.length,
            fullSerializationMs, projectionAndSerializationMs,
            observedTargets: observation.targets.length,
            projectedTargets: (projected.targets as unknown[]).length,
            projectedCoverage: projected.coverage, forcedTrimCoverage: forcedTrim.coverage, screenshotBytes,
          });
        }
      } finally { await driver.close(); }
    }
    const fullChars = samples.reduce((total, sample) => total + sample.fullChars, 0);
    const projectedChars = samples.reduce((total, sample) => total + sample.projectedChars, 0);
    const require = createRequire(import.meta.url);
    const digest = createHash('sha256');
    for (const file of ['../protocol/observation-utils.js', '../drivers/browser/browser-driver.js', '../fixtures/web-app.js']) {
      // Source runs use .ts; built runs use .js. Record exactly what was read.
      const url = new URL(file, import.meta.url);
      digest.update(await readFile(url).catch(() => readFile(new URL(file.replace(/\.js$/, '.ts'), import.meta.url))));
    }
    return {
      schemaVersion: 1, measuredAt: new Date().toISOString(), mode: 'paired-live-observation-payload',
      environment: { node: process.version, platform: process.platform, arch: process.arch, playwright: require('playwright/package.json').version },
      sourceDigest: digest.digest('hex'), sampleSize: samples.length, fixtureCases: 3, repeats,
      fullChars, projectedChars, reductionRatio: fullChars ? 1 - projectedChars / fullChars : null,
      modelCalls: null, costUsd: null, taskSuccessRate: null,
      fullControllerComparison: 'not_run',
      note: 'Real Chromium observations, paired serialization on the same input. Characters are UTF-16 string lengths, not token counts. PNG bytes are reported separately and excluded from both JSON counts. This measures observation payload only; no model calls or before/after task success, latency, or cost improvement is claimed. This measurement does not run the controller; see the separate controller comparison. Serialization timings are descriptive small samples with fixed full-then-projection order.',
      samples,
    };
  } finally {
    await fixture.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
