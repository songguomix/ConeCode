import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { startFixtureServer } from '../fixtures/web-app.js';
import type { Condition } from '../protocol/schemas.js';
import { RuntimeService } from '../service/runtime-service.js';

/** Real controller/browser comparison; scripted decisions, not model inference. */
export async function compareController() {
  const dir = await mkdtemp(join(tmpdir(), 'cua-controller-comparison-'));
  const fixture = await startFixtureServer({ dataFile: join(dir, 'fixture.json') });
  const results: Array<{
    scenario: string; observationMode: 'full' | 'projected'; order: number;
    acceptance: Condition[]; budgets: Record<string, number>; status: string;
    durableRecord: { id: number; name: string } | null; acceptancePassed: boolean;
    modelRequestCount: number; actionCount: number; durationMs: number;
    costUsd: null; pass: boolean;
  }> = [];
  try {
    for (const [index, scenario] of [{ name: 'ordinary_save', delayMs: 0 }, { name: 'delayed_save', delayMs: 150 }].entries()) {
      const acceptance: Condition[] = [
        { kind: 'record_field', method: 'GET', url: `${fixture.url}/api/projects/1`, path: ['name'], equals: 'Demo' },
        { kind: 'text_visible', text: 'Saved successfully', scope: 'page' },
      ];
      const budgets = { maxSteps: 8, maxModelCalls: 5, maxWallClockMs: 30_000, maxCostUsd: 0.1 };
      const modes: Array<'full' | 'projected'> = index % 2 ? ['projected', 'full'] : ['full', 'projected'];
      for (const observationMode of modes) {
        await fixture.reset();
        const service = new RuntimeService({
          dataDir: join(dir, `${scenario.name}-${observationMode}`), observationMode,
          recoverOnStart: false, monitorIntervalMs: 0, sendScreenshots: false, maxConcurrency: 1,
        });
        const started = performance.now();
        try {
          await service.start();
          const task = await service.createTask({
            goal: 'Change the project name to Demo and save it.',
            acceptance: structuredClone(acceptance), budgets: { ...budgets },
            authorization: { allowedOrigins: [fixture.url], allowCode: false },
            environment: { kind: 'browser', startUrl: `${fixture.url}/?delay=${scenario.delayMs}`, headless: true },
            model: { provider: 'scripted', model: 'scripted-deterministic' },
            script: [
              { kind: 'tool', name: 'browser_fill', arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Demo' } },
              { kind: 'tool', name: 'browser_click', arguments: { target: { role: 'button', name: 'Save' }, expected: [{ ...acceptance[0], withinMs: 5_000 }, { ...acceptance[1], withinMs: 5_000 }] } },
              { kind: 'tool', name: 'finish', arguments: { summary: 'Saved Demo; independently verify the original acceptance.' } },
            ],
          });
          const final = await service.awaitTask(task.id, { timeoutMs: 35_000 });
          const details = service.getTask(task.id);
          const project = (await fixture.readData()).projects.find((record) => record.id === 1);
          const acceptancePassed = details.verifications.some((verification) => verification.scope === 'task' && verification.verdict === 'pass');
          results.push({
            scenario: scenario.name, observationMode, order: results.length + 1,
            acceptance: details.task.acceptance, budgets, status: final.status,
            durableRecord: project ? { id: project.id, name: project.name } : null,
            acceptancePassed, modelRequestCount: details.events.filter((event) => event.type === 'model.request').length,
            actionCount: details.actions.length, durationMs: performance.now() - started, costUsd: null,
            pass: final.status === 'succeeded' && acceptancePassed && project?.name === 'Demo',
          });
        } finally { await service.close(); }
      }
    }
    const sourceDigest = createHash('sha256');
    for (const file of ['./planner.js', '../service/runtime-service.js', './task-controller.js', '../drivers/browser/browser-driver.js', '../fixtures/web-app.js']) {
      sourceDigest.update(await readFile(new URL(file, import.meta.url)).catch(() => readFile(new URL(file.replace(/\.js$/, '.ts'), import.meta.url))));
    }
    const require = createRequire(import.meta.url);
    return {
      schemaVersion: 1, measuredAt: new Date().toISOString(), mode: 'scripted-real-controller-paired-comparison',
      environment: { node: process.version, platform: process.platform, arch: process.arch, playwright: require('playwright/package.json').version },
      sourceDigest: sourceDigest.digest('hex'), fixtureCases: 2, sampleSize: results.length,
      passed: results.filter((result) => result.pass).length, realModelCalls: 0, costUsd: null,
      note: 'Alternating full/projected observation modes through the same TaskController, Executor and independent acceptance, with identical fixture reset, script, budgets and original acceptance per pair. ScriptedAdapter does not perform inference or adapt decisions to observation size. modelRequestCount counts actual model.request events, not paid provider calls. Durations are single-run descriptive samples, excluding service teardown. No speed, cost or real-model success improvement is claimed.',
      results,
    };
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
}
