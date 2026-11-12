#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeService } from './service/runtime-service.js';
import { CuaHttpServer } from './service/http-server.js';
import { CuaClient } from './sdk.js';
import { startFixtureServer } from './fixtures/web-app.js';
import type { Condition, CreateTaskInput } from './protocol/schemas.js';

const HELP = `Computer Use Agent runtime

Usage:
  cua serve [--port 4317] [--data-dir .cua] [--no-recover] [--open]
  cua task list [--api URL] [--token TOKEN]
  cua task show <taskId>
  cua task events <taskId> [--since N] [--follow]
  cua task pause|resume|cancel|takeover|release|recover <taskId>
  cua task input <taskId> --kind approval|answer|freeform --text "..."
  cua task create --goal "..." --acceptance '<json array>' --url URL [--script file.json] [--model MODEL] [--api-key-env ENV] [--images]
  cua demo browser [--headless] [--keep]
  cua demo desktop [--yes] [--text "..."] [--file PATH]
  cua eval [--json] [--filter NAME]
  cua eval --real --model MODEL [--base-url URL] [--max-model-calls 8] [--max-cost-usd 0.5]
  cua mcp (use: npm run mcp)

Environment:
  CUA_API_URL       base URL for client commands (default http://127.0.0.1:4317)
  CUA_TOKEN         bearer token (otherwise .cua/server-token is read)
  CUA_DATA_DIR      data directory (default ./.cua)
  OPENAI_API_KEY    required only for real OpenAI-compatible model runs
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      port: { type: 'string' },
      host: { type: 'string' },
      'data-dir': { type: 'string' },
      'no-recover': { type: 'boolean' },
      open: { type: 'boolean' },
      api: { type: 'string' },
      token: { type: 'string' },
      goal: { type: 'string' },
      acceptance: { type: 'string' },
      url: { type: 'string' },
      app: { type: 'string' },
      scope: { type: 'string' },
      script: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string' },
      images: { type: 'boolean' },
      kind: { type: 'string' },
      text: { type: 'string' },
      since: { type: 'string' },
      follow: { type: 'boolean' },
      headless: { type: 'boolean' },
      keep: { type: 'boolean' },
      yes: { type: 'boolean' },
      file: { type: 'string' },
      json: { type: 'boolean' },
      real: { type: 'boolean' },
      filter: { type: 'string' },
      'max-model-calls': { type: 'string' },
      'max-cost-usd': { type: 'string' },
      'token-parameter': { type: 'string' },
      'input-price': { type: 'string' },
      'output-price': { type: 'string' },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }
  const command = positionals[0]!;
  if (command === 'serve') return serve(values);
  if (command === 'task') return task(positionals.slice(1), values);
  if (command === 'demo') return demo(positionals[1], values);
  if (command === 'eval') {
    const { runEvaluation } = await import('./eval.js');
    const maxModelCalls = Number(values['max-model-calls'] ?? 8);
    const maxCostUsd = Number(values['max-cost-usd'] ?? 0.5);
    if (!Number.isInteger(maxModelCalls) || maxModelCalls < 1 || !Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
      throw new Error('Evaluation budgets must be a positive integer call count and a nonnegative finite cost.');
    }
    const tokenParameter = values['token-parameter'] ?? 'max_completion_tokens';
    if (!['max_tokens', 'max_completion_tokens'].includes(tokenParameter)) throw new Error('Invalid --token-parameter.');
    const prices = [values['input-price'], values['output-price']];
    if (prices.some((p) => p !== undefined) && !prices.every((p) => p !== undefined && Number.isFinite(Number(p)) && Number(p) >= 0)) {
      throw new Error('Set both --input-price and --output-price to nonnegative USD per million tokens.');
    }
    const report = await runEvaluation({
      scripted: !values.real, model: values.model, filter: values.filter,
      baseUrl: values['base-url'], apiKeyEnv: values['api-key-env'], images: values.images,
      maxModelCalls, maxCostUsd, tokenParameter: tokenParameter as 'max_tokens' | 'max_completion_tokens',
      ...(prices[0] === undefined ? {} : { pricing: { inputPerMillionUsd: Number(prices[0]), outputPerMillionUsd: Number(prices[1]) } }),
    });
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else printEvaluation(report);
    if (report.status === 'not_run') process.exitCode = 2;
    else if (report.passed !== report.total) process.exitCode = 1;
    return;
  }
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exitCode = 1;
}

async function serve(values: Record<string, any>): Promise<void> {
  const service = new RuntimeService({
    dataDir: values['data-dir'],
    recoverOnStart: !values['no-recover'],
    headless: true,
  });
  await service.start();
  const server = new CuaHttpServer(service, {
    port: values.port ? Number(values.port) : undefined,
    host: values.host,
    token: process.env.CUA_AUTH_TOKEN,
  });
  const info = await server.start();
  console.log(`CUA runtime listening at ${info.url}`);
  console.log(`Bearer token file: ${info.tokenFile}`);
  console.log(`React console: ${info.url}/`);
  if (values.open) {
    const { execFile } = await import('node:child_process');
    execFile('/usr/bin/open', [info.url], () => undefined);
  }
  const shutdown = async () => {
    await server.close();
    await service.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => undefined);
}

function client(values: Record<string, any>): CuaClient {
  return new CuaClient({ baseUrl: values.api, token: values.token, dataDir: values['data-dir'] });
}

async function task(args: string[], values: Record<string, any>): Promise<void> {
  const sub = args[0];
  const id = args[1];
  const c = client(values);
  switch (sub) {
    case 'list': {
      console.log(JSON.stringify(await c.listTasks(), null, 2));
      return;
    }
    case 'create': {
      if (!values.goal || !values.acceptance) throw new Error('task create needs --goal and --acceptance.');
      if (!values.script && !values.model) throw new Error('Real-model tasks require an explicit --model.');
      const acceptance = JSON.parse(values.acceptance) as Condition[];
      const environment = values.url
        ? { kind: 'browser' as const, startUrl: values.url, headless: true, profile: 'default' }
        : {
            kind: 'desktop' as const,
            // Desktop computer use reads exactly one app window unless the
            // caller explicitly opts into whole-display capture.
            scope: values.scope === 'display' ? ('display' as const) : ('app' as const),
            ...(values.app ? { appName: values.app } : {}),
          };
      const input: CreateTaskInput = {
        goal: values.goal,
        constraints: [],
        acceptance,
        acceptanceSource: 'user',
        authorization: {
          allowedOrigins: values.url ? [new URL(values.url).origin] : [],
          allowedTools: [],
          allowDesktop: environment.kind === 'desktop',
          allowCode: true,
          allowedFileRoots: [],
          allowedRecipients: [],
        },
        budgets: {},
        environment,
        metadata: {},
        model: {
          provider: values.script ? 'scripted' : 'openai',
          model: values.model ?? 'scripted-deterministic',
          ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
          ...(values['api-key-env'] ? { apiKeyEnv: values['api-key-env'] } : {}),
          ...(values.images ? { capabilities: { images: true } } : {}),
        },
        ...(values.script ? { script: JSON.parse(await readFile(values.script, 'utf8')) } : {}),
      };
      console.log(JSON.stringify(await c.createTask(input), null, 2));
      return;
    }
    case 'show': {
      if (!id) throw new Error('task show needs a taskId.');
      console.log(JSON.stringify(await c.getTask(id), null, 2));
      return;
    }
    case 'events': {
      if (!id) throw new Error('task events needs a taskId.');
      const since = Number(values.since ?? 0);
      if (values.follow) {
        for await (const event of c.stream(id, since)) console.log(JSON.stringify(event));
      } else {
        console.log(JSON.stringify(await c.events(id, since), null, 2));
      }
      return;
    }
    case 'input': {
      if (!id) throw new Error('task input needs a taskId.');
      const input = {
        kind: (values.kind ?? 'answer') as 'approval' | 'answer' | 'freeform',
        text: String(values.text ?? ''),
      };
      console.log(JSON.stringify(await c.submitInput(id, input), null, 2));
      return;
    }
    case 'pause':
    case 'resume':
    case 'cancel':
    case 'takeover':
    case 'release':
    case 'recover': {
      if (!id) throw new Error(`task ${sub} needs a taskId.`);
      console.log(JSON.stringify(await c.control(id, sub as any), null, 2));
      return;
    }
    default:
      throw new Error(`Unknown task subcommand: ${sub}. See --help.`);
  }
}

async function demo(which: string | undefined, values: Record<string, any>): Promise<void> {
  if (which === 'browser') return demoBrowser(values);
  if (which === 'desktop') return demoDesktop(values);
  throw new Error('demo needs "browser" or "desktop".');
}

async function demoBrowser(values: Record<string, any>): Promise<void> {
  const fixture = await startFixtureServer();
  await fixture.reset();
  const dataDir = resolve(values['data-dir'] ?? join(process.cwd(), '.cua', 'demo-browser'));
  const service = new RuntimeService({ dataDir, recoverOnStart: false, headless: values.headless !== false });
  await service.start();
  const task = await service.createTask({
    goal: 'Change the project name to Demo and save it. Then re-read the persisted record.',
    constraints: ['Use the local fixture only.'],
    acceptance: [
      { kind: 'record_field', url: `${fixture.url}/api/projects/1`, method: 'GET', path: ['name'], equals: 'Demo' },
      { kind: 'text_visible', text: 'Saved successfully', scope: 'page' },
    ],
    environment: { kind: 'browser', startUrl: fixture.url, headless: values.headless !== false },
    model: { provider: 'scripted' },
    script: [
      {
        kind: 'tool',
        name: 'browser_fill',
        arguments: {
          target: { role: 'textbox', name: 'Project name' },
          value: 'Demo',
          expected: [{ kind: 'value_equals', targetId: '$target', value: 'Demo' }],
        },
      },
      {
        kind: 'tool',
        name: 'browser_click',
        arguments: {
          target: { role: 'button', name: 'Save' },
          expected: [
            { kind: 'text_visible', text: 'Saved successfully', withinMs: 5_000 },
            { kind: 'record_field', url: `${fixture.url}/api/projects/1`, path: ['name'], equals: 'Demo', withinMs: 5_000 },
          ],
        },
      },
      { kind: 'tool', name: 'finish', arguments: { summary: 'Renamed and saved the project.' } },
    ],
  });
  console.log(`Created ${task.id}; running deterministic scripted browser demo…`);
  const final = await service.awaitTask(task.id, { timeoutMs: 120_000 });
  const data = await fixture.readData();
  console.log(`Status: ${final.status} — ${final.statusReason}`);
  console.log(`Persisted project: ${JSON.stringify(data.projects[0])}`);
  console.log(`Artifacts: ${join(service.config.artifactsDir, task.id)}`);
  if (final.status !== 'succeeded' || data.projects[0]?.name !== 'Demo') process.exitCode = 1;
  if (!values.keep) {
    await service.close();
    await fixture.close();
  } else {
    console.log(`Keeping runtime open. API data dir: ${dataDir}`);
    console.log(`Fixture URL: ${fixture.url}`);
  }
}

async function demoDesktop(values: Record<string, any>): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('The desktop demo is implemented and verified for macOS only.');
  if (!values.yes) {
    console.log('The desktop demo performs a real TextEdit write and save, so it requires explicit consent.');
    console.log('Re-run with --yes to approve the local write. No task was created.');
    return;
  }
  const text = values.text ?? 'CUA desktop demo\n计算机使用：中文与 Unicode 输入。';
  const file = resolve(values.file ?? join(tmpdir(), `cua-desktop-demo-${Date.now()}.txt`));
  const dataDir = resolve(values['data-dir'] ?? join(process.cwd(), '.cua', 'demo-desktop'));
  const service = new RuntimeService({ dataDir, recoverOnStart: false });
  await service.start();
  const task = await service.createTask({
    goal: `Open TextEdit, write the provided text, and save it to ${file}.`,
    constraints: ['Use the local TextEdit app-scripting channel because raw synthetic input may be permission-blocked.'],
    acceptance: [{ kind: 'file_content', path: file, equals: text }],
    authorization: {
      allowedOrigins: [],
      allowedTools: ['desktop.*', 'task.finish'],
      allowDesktop: true,
      allowCode: false,
      allowedFileRoots: [tmpdir(), dirname(file)],
      allowedRecipients: [],
    },
    environment: { kind: 'desktop', appName: 'TextEdit', workdir: tmpdir() },
    model: { provider: 'scripted' },
    script: [
      {
        kind: 'tool',
        name: 'desktop_edit_document',
        arguments: { appName: 'TextEdit', content: text, savePath: file },
      },
      { kind: 'tool', name: 'finish', arguments: { summary: 'Saved the document and verified the file.' } },
    ],
  });
  console.log(`Created ${task.id} (approval is required for the app-scripting write).`);
  let details = await service.getTask(task.id);
  for (let i = 0; i < 600; i++) {
    details = await service.getTask(task.id);
    if (details.task.status === 'awaiting_user') {
      await service.submitInput(task.id, { kind: 'approval', text: 'approve' });
    }
    if (['succeeded', 'failed', 'cancelled', 'needs_attention'].includes(details.task.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const final = await service.awaitTask(task.id, { timeoutMs: 20_000 });
  const content = await readFile(file, 'utf8').catch(() => null);
  console.log(`Status: ${final.status} — ${final.statusReason}`);
  console.log(`File: ${file}`);
  console.log(`Content matches: ${content === text}`);
  await service.close();
  if (final.status !== 'succeeded' || content !== text) process.exitCode = 1;
}

function printEvaluation(report: any): void {
  console.log(`Evaluation (${report.mode}, ${report.status}): ${report.passed}/${report.total} passed`);
  for (const result of report.results) {
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.name} (${result.durationMs}ms) ${result.detail}`);
  }
  if (report.note) console.log(`\n${report.note}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
