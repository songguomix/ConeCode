import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtures/web-app.js';
import { RuntimeService } from './service/runtime-service.js';
import type { Condition, CreateTaskInput } from './protocol/schemas.js';
import type { ScriptStep } from './model/scripted.js';

export interface ScenarioResult {
  name: string;
  pass: boolean;
  expected: string;
  detail: string;
  status: string;
  durationMs: number;
  modelCalls: number;
  actions: number;
  falseCompletion: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

export interface EvaluationReport {
  sampledAt: string;
  mode: 'scripted' | 'real-model';
  total: number;
  passed: number;
  status: 'completed' | 'not_run';
  successRate: number | null;
  /** Expectation pass rate includes intentional failure scenarios. */
  scenarioPassRate?: number | null;
  falseCompletionRate: number | null;
  results: ScenarioResult[];
  note: string;
  model?: string;
  environment?: { node: string; platform: string; arch: string };
}

interface Scenario {
  name: string;
  expected: string;
  expectSucceeded: boolean;
  acceptedStatuses?: string[];
  build(fixture: FixtureServer): CreateTaskInput;
  check?(fixture: FixtureServer, result: ScenarioResult): Promise<boolean>;
}

function baseInput(goal: string, url: string, acceptance: Condition[], script: ScriptStep[], budgets = {}): CreateTaskInput {
  return {
    goal,
    constraints: [],
    acceptance,
    acceptanceSource: 'user',
    authorization: {
      allowedOrigins: [url],
      allowedTools: [],
      allowDesktop: false,
      allowCode: false,
      allowedFileRoots: [],
      allowedRecipients: [],
    },
    budgets,
    environment: { kind: 'browser', startUrl: url, headless: true, profile: 'default' },
    metadata: {},
    model: { provider: 'scripted', model: 'scripted-deterministic' },
    script: script as unknown as Array<Record<string, unknown>>,
  };
}

function scenarios(fixture: FixtureServer): Scenario[] {
  const recordDemo: Condition = {
    kind: 'record_field',
    url: `${fixture.url}/api/projects/1`,
    method: 'GET',
    path: ['name'],
    equals: 'Demo',
  };
  return [
    {
      name: 'baseline_form_save',
      expected: 'Task succeeds and the persisted record is Demo; UI toast is not the only evidence.',
      expectSucceeded: true,
      build: () =>
        baseInput(
          'Change the project name to Demo and save it.',
          fixture.url,
          [recordDemo, { kind: 'text_visible', text: 'Saved successfully', scope: 'page' }],
          [
            {
              kind: 'tool',
              name: 'browser_fill',
              arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Demo' },
            },
            {
              kind: 'tool',
              name: 'browser_click',
              arguments: {
                target: { role: 'button', name: 'Save' },
                expected: [
                  { kind: 'text_visible', text: 'Saved successfully', withinMs: 5_000 },
                  { ...recordDemo, withinMs: 5_000 },
                ],
              },
            },
            { kind: 'tool', name: 'finish', arguments: { summary: 'Renamed and saved.' } },
          ],
        ),
    },
    {
      name: 'save_failure_then_recover',
      expected: 'A failed save is observed, the agent navigates back to a clean page, retries and verifies the persisted record.',
      expectSucceeded: true,
      build: () =>
        baseInput(
          'Save Demo despite the injected first failure.',
          `${fixture.url}/?fail=1`,
          [recordDemo],
          [
            {
              kind: 'tool',
              name: 'browser_fill',
              arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Demo' },
            },
            {
              kind: 'tool',
              name: 'browser_click',
              arguments: {
                target: { role: 'button', name: 'Save' },
                expected: [{ kind: 'text_visible', text: 'Save failed', withinMs: 5_000 }],
              },
            },
            {
              kind: 'tool',
              name: 'browser_navigate',
              arguments: { url: fixture.url, expected: [{ kind: 'text_visible', text: 'Project name', withinMs: 5_000 }] },
            },
            {
              kind: 'tool',
              name: 'browser_fill',
              arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Demo' },
            },
            {
              kind: 'tool',
              name: 'browser_click',
              arguments: {
                target: { role: 'button', name: 'Save' },
                expected: [
                  { kind: 'text_visible', text: 'Saved successfully', withinMs: 5_000 },
                  { ...recordDemo, withinMs: 5_000 },
                ],
              },
            },
            { kind: 'tool', name: 'finish', arguments: { summary: 'Retried after the failure and saved.' } },
          ],
        ),
    },
    {
      name: 'fake_success_rejected',
      expected: 'A fake UI success toast does not become task success; the persisted record remains Alpha.',
      expectSucceeded: false,
      acceptedStatuses: ['failed', 'needs_attention'],
      build: () =>
        baseInput(
          'Save Demo. The page may show a false success message.',
          `${fixture.url}/?fake=1`,
          [recordDemo],
          [
            {
              kind: 'tool',
              name: 'browser_fill',
              arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Demo' },
            },
            {
              kind: 'tool',
              name: 'browser_click',
              arguments: {
                target: { role: 'button', name: 'Save' },
                expected: [{ kind: 'text_visible', text: 'Saved successfully', withinMs: 5_000 }],
              },
            },
            { kind: 'tool', name: 'finish', arguments: { summary: 'The UI says it saved.' } },
          ],
          { maxModelCalls: 5, maxSteps: 8 },
        ),
      check: async (fixture, result) => {
        const data = await fixture.readData();
        return !result.falseCompletion && data.projects[0]!.name === 'Alpha';
      },
    },
    {
      name: 'budget_exhaustion_is_terminal',
      expected: 'A tiny step/model budget terminates the task without claiming success.',
      expectSucceeded: false,
      acceptedStatuses: ['failed'],
      build: () =>
        baseInput(
          'Try to save Demo with an almost exhausted budget.',
          fixture.url,
          [recordDemo],
          [
            {
              kind: 'tool',
              name: 'browser_fill',
              arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Demo' },
            },
            {
              kind: 'tool',
              name: 'browser_click',
              arguments: { target: { role: 'button', name: 'Save' } },
            },
            { kind: 'tool', name: 'finish', arguments: { summary: 'Done.' } },
          ],
          { maxSteps: 1, maxModelCalls: 2, maxWallClockMs: 60_000 },
        ),
      check: async (_fixture, result) => /budget|exhaust/i.test(result.detail),
    },
  ];
}

export interface EvaluationOptions {
  scripted?: boolean;
  filter?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  images?: boolean;
  maxModelCalls?: number;
  maxWallClockMs?: number;
  maxCostUsd?: number;
  pricing?: { inputPerMillionUsd: number; outputPerMillionUsd: number };
  tokenParameter?: 'max_tokens' | 'max_completion_tokens';
}

export async function runEvaluation(options: EvaluationOptions = {}): Promise<EvaluationReport> {
  const real = options.scripted === false;
  const model = options.model ?? process.env.CUA_REAL_MODEL;
  const credentialEnv = options.apiKeyEnv ?? 'OPENAI_API_KEY';
  if (real && (!model || !process.env[credentialEnv])) {
    return {
      sampledAt: new Date().toISOString(),
      mode: 'real-model',
      total: 0,
      passed: 0,
      status: 'not_run',
      successRate: null,
      falseCompletionRate: null,
      results: [],
      note: `Real-model evaluation NOT marked as passed: ${!model ? 'select a model with --model or CUA_REAL_MODEL; ' : ''}${!process.env[credentialEnv] ? `set ${credentialEnv}; ` : ''}no inference or browser task was run.`,
    };
  }
  const fixture = await startFixtureServer();
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of scenarios(fixture)) {
      if (options.filter && !scenario.name.includes(options.filter)) continue;
      // The live baseline is a genuine model-directed form task. The other
      // scenarios are controller fault tests with pre-scripted interventions.
      if (real && scenario.name !== 'baseline_form_save') continue;
      await fixture.reset();
      const dataDir = await mkdtemp(join(tmpdir(), `cua-eval-${scenario.name}-`));
      const service = new RuntimeService({ dataDir, recoverOnStart: false, headless: true, monitorIntervalMs: 0 });
      const started = Date.now();
      let status = 'error';
      let pass = false;
      let detail = '';
      let modelCalls = 0;
      let actions = 0;
      let falseCompletion = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd: number | null = real && !options.pricing ? null : 0;
      try {
        await service.start();
        const input = scenario.build(fixture);
        if (real) {
          delete input.script;
          input.model = {
            provider: 'openai', model: model!, apiKeyEnv: credentialEnv,
            baseUrl: options.baseUrl ?? process.env.OPENAI_BASE_URL,
            capabilities: { tools: true, images: options.images ?? false, structuredOutput: false },
            tokenParameter: options.tokenParameter ?? 'max_completion_tokens',
            pricing: options.pricing,
          };
          input.budgets = {
            maxSteps: 12, maxModelCalls: options.maxModelCalls ?? 8,
            maxWallClockMs: options.maxWallClockMs ?? 120_000,
            maxCostUsd: options.maxCostUsd ?? 0.5, maxInputTokens: 30_000, maxOutputTokens: 6_000,
          };
        }
        const task = await service.createTask(input);
        const final = await service.awaitTask(task.id, { timeoutMs: (options.maxWallClockMs ?? 120_000) + 5_000 });
        status = final.status;
        const details = service.getTask(task.id);
        modelCalls = details.events.filter((e) => e.type === 'model.request').length;
        for (const event of details.events.filter((e) => e.type === 'model.response')) {
          const usage = event.payload.usage as { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;
          inputTokens += usage?.inputTokens ?? 0;
          outputTokens += usage?.outputTokens ?? 0;
          if (costUsd !== null) costUsd += usage?.costUsd ?? 0;
        }
        actions = details.actions.length;
        const durable = await fixture.readData();
        falseCompletion = final.status === 'succeeded' && (!scenario.expectSucceeded || durable.projects[0]?.name !== 'Demo');
        pass = scenario.expectSucceeded
          ? final.status === 'succeeded' && !falseCompletion
          : (scenario.acceptedStatuses ?? ['failed', 'needs_attention', 'cancelled']).includes(final.status);
        detail = `status=${final.status}; reason=${final.statusReason ?? ''}`;
        if (pass && scenario.check) pass = await scenario.check(fixture, {
          name: scenario.name,
          pass,
          expected: scenario.expected,
          detail,
          status,
          durationMs: Date.now() - started,
          modelCalls,
          actions,
          falseCompletion,
        });
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
        pass = false;
      } finally {
        await service.close().catch(() => undefined);
        await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
      }
      results.push({
        name: scenario.name,
        pass,
        expected: scenario.expected,
        detail,
        status,
        durationMs: Date.now() - started,
        modelCalls,
        actions,
        falseCompletion,
        inputTokens, outputTokens, costUsd,
      });
    }
  } finally {
    await fixture.close();
  }
  const passed = results.filter((r) => r.pass).length;
  const falseCompletions = results.filter((r) => r.falseCompletion).length;
  return {
    sampledAt: new Date().toISOString(),
    mode: real ? 'real-model' : 'scripted',
    status: results.length ? 'completed' : 'not_run',
    ...(real ? { model } : {}),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    total: results.length,
    passed,
    successRate: results.length ? results.filter((r) => r.status === 'succeeded').length / results.length : null,
    scenarioPassRate: results.length ? passed / results.length : null,
    falseCompletionRate: results.length ? falseCompletions / results.length : null,
    results,
    note: real
      ? 'Live provider baseline against a real Chromium fixture; independent durable record verification. Sample count is explicit. Costs are null without configured pricing; model failure is never a passing task.'
      : 'Deterministic scripted controller evaluation, not a real-model benchmark. No API key is used and no model inference occurs. Real-model results are reported separately.',
  };
}
