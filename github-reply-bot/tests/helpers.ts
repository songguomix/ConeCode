import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app';
import { loadConfig, type AppConfig } from '../src/server/config';
import { openDatabase, type DatabaseHandle } from '../src/server/db';
import { Store } from '../src/server/db/store';
import { computeSignature } from '../src/server/webhook/signature';
import { processNextJob, type WorkerDeps } from '../src/server/worker/worker';
import type { RepoSettingsDto, RepositoryDto } from '../src/shared/types';
import { FakeGitHub } from './fakeGithub';

export const TEST_ADMIN_TOKEN = 'test-admin-token-123456';
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret-123456';
export const TEST_APP_SLUG = 'reply-bot';

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'file::memory:',
    LOG_LEVEL: 'silent',
    ADMIN_TOKEN: TEST_ADMIN_TOKEN,
    GITHUB_APP_ID: '12345',
    GITHUB_PRIVATE_KEY: 'fake-private-key',
    GITHUB_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    GITHUB_APP_SLUG: TEST_APP_SLUG,
    ...overrides,
  });
}

export interface TestContext {
  database: DatabaseHandle;
  store: Store;
  github: FakeGitHub;
  config: AppConfig;
  app: FastifyInstance;
  close: () => Promise<void>;
}

export async function createTestApp(options: {
  env?: Record<string, string | undefined>;
  configure?: (store: Store) => void;
  github?: FakeGitHub;
  createGenerator?: WorkerDeps['createGenerator'];
} = {}): Promise<TestContext> {
  const config = testConfig(options.env);
  const database = openDatabase(':memory:', path.resolve('drizzle'));
  const store = new Store(database);
  store.seedBuiltinTemplates();
  if (options.configure) options.configure(store);
  const github = options.github ?? new FakeGitHub();
  const built = await buildApp({
    config,
    database,
    github,
    startWorker: false,
    logger: false,
    createGenerator: options.createGenerator,
  });
  return {
    database,
    store,
    github,
    config,
    app: built.app,
    close: async () => {
      await built.app.close();
      database.close();
    },
  };
}

export function seedRepo(
  store: Store,
  options: { enabled?: boolean; settings?: Partial<Omit<RepoSettingsDto, 'updatedAt'>> } = {}
): { repo: RepositoryDto; settings: RepoSettingsDto } {
  const installation = store.upsertInstallation(9001, 'acme');
  const created = store.upsertRepository(installation.id, 500, 'acme', 'widgets');
  if (options.enabled) store.setRepoEnabled(created.id, true);
  if (options.settings) store.updateRepoSettings(created.id, options.settings);
  const repo = store.getRepositoryById(created.id);
  if (!repo) throw new Error('repo not created');
  return { repo, settings: store.getRepoSettings(repo.id) };
}

export function enableAutomation(store: Store, overrides: Record<string, unknown> = {}): void {
  store.updateGlobalSettings({
    automationEnabled: true,
    dryRun: false,
    generatorProvider: 'template',
    ...overrides,
  });
}

export function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    issue: {
      number: 7,
      title: 'Crash when starting the app',
      body: 'Steps to reproduce: run the app. Expected: it starts. Actual: it crashes. Version 1.2.3.',
      user: { login: 'alice', type: 'User' },
      labels: [{ name: 'bug' }],
    },
    repository: {
      id: 500,
      name: 'widgets',
      owner: { login: 'acme' },
      full_name: 'acme/widgets',
    },
    installation: { id: 9001, account: { login: 'acme' } },
    sender: { login: 'alice', type: 'User' },
    ...overrides,
  };
}

export interface PostWebhookOptions {
  event: string;
  delivery?: string;
  payload?: unknown;
  secret?: string;
  signature?: string | null;
  app?: FastifyInstance;
}

export function postWebhook(ctx: TestContext, options: PostWebhookOptions) {
  const raw = JSON.stringify(options.payload ?? issuePayload());
  const target = options.app ?? ctx.app;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': options.event,
    'x-github-delivery': options.delivery ?? `delivery-${Math.random().toString(36).slice(2)}`,
  };
  if (options.signature === undefined) {
    headers['x-hub-signature-256'] = computeSignature(options.secret ?? TEST_WEBHOOK_SECRET, raw);
  } else if (options.signature !== null) {
    headers['x-hub-signature-256'] = options.signature;
  }
  return target.inject({ method: 'POST', url: '/webhook', headers, payload: raw });
}

export function workerDeps(ctx: TestContext, overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    store: ctx.store,
    github: ctx.github,
    config: ctx.config,
    maxAttempts: 3,
    backoffMs: () => 1000,
    now: () => new Date(),
    ...overrides,
  };
}

export async function drainWorker(ctx: TestContext, overrides: Partial<WorkerDeps> = {}): Promise<number> {
  let processed = 0;
  for (let i = 0; i < 20; i += 1) {
    const job = await processNextJob(workerDeps(ctx, overrides));
    if (!job) break;
    processed += 1;
  }
  return processed;
}

export function authHeader(token = TEST_ADMIN_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

const REPOSITORY = {
  id: 500,
  name: 'widgets',
  owner: { login: 'acme' },
  full_name: 'acme/widgets',
};

const INSTALLATION = { id: 9001, account: { login: 'acme' } };

export function pullRequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    pull_request: {
      number: 9,
      title: 'Add caching layer',
      body: 'Adds a cache layer. Manual testing: run npm test. Related issue #3.',
      user: { login: 'bob', type: 'User' },
      labels: [{ name: 'enhancement' }],
    },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: 'bob', type: 'User' },
    ...overrides,
  };
}

export function commentPayload(body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'created',
    issue: {
      number: 7,
      title: 'Crash when starting the app',
      body: 'Steps to reproduce: run the app.',
      user: { login: 'alice', type: 'User' },
      labels: [{ name: 'bug' }],
    },
    comment: { id: 4242, body, user: { login: 'bob', type: 'User' } },
    repository: REPOSITORY,
    installation: INSTALLATION,
    sender: { login: 'bob', type: 'User' },
    ...overrides,
  };
}

export function installationPayload(
  action: string,
  repositories: Array<{ id: number; name: string }> = [{ id: 777, name: 'brand-new' }]
): Record<string, unknown> {
  return {
    action,
    installation: { id: 9001, account: { login: 'acme' } },
    repositories: repositories.map((repo) => ({
      id: repo.id,
      name: repo.name,
      owner: { login: 'acme' },
      full_name: `acme/${repo.name}`,
    })),
    sender: { login: 'acme-admin', type: 'User' },
  };
}
