import { afterEach, describe, expect, it } from 'vitest';
import { GitHubApiError } from '../src/server/github/types';
import {
  createTestApp,
  drainWorker,
  enableAutomation,
  issuePayload,
  postWebhook,
  seedRepo,
  type TestContext,
} from './helpers';

let ctx: TestContext | null = null;

afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

async function queueAutoPostRun(context: TestContext): Promise<number> {
  enableAutomation(context.store);
  context.github.permissions = { alice: 'maintain' };
  seedRepo(context.store, {
    enabled: true,
    settings: { onIssueOpened: true, autoPostEnabled: true, requireApproval: false },
  });
  const response = await postWebhook(context, { event: 'issues', payload: issuePayload() });
  return response.json().runId;
}

describe('worker failure handling', () => {
  it('retries transient GitHub failures with backoff and fails after the third attempt', async () => {
    ctx = await createTestApp();
    const runId = await queueAutoPostRun(ctx);
    const failure = () => new GitHubApiError('API rate limit exceeded', 'github_rate_limited', 403);
    ctx.github.createCommentFailures = [failure(), failure(), failure()];

    await drainWorker(ctx);
    let run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('retrying');
    expect(run?.errorCode).toBe('github_rate_limited');
    expect(run?.attempts).toBe(1);
    const jobs = ctx.store.listJobsForRun(runId);
    expect(jobs.at(-1)?.status).toBe('pending');
    expect(new Date(jobs.at(-1)!.availableAt).getTime()).toBeGreaterThan(Date.now());

    await drainWorker(ctx, { now: () => new Date(Date.now() + 5_000) });
    run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('retrying');
    expect(run?.attempts).toBe(2);

    await drainWorker(ctx, { now: () => new Date(Date.now() + 120_000) });
    run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('failed');
    expect(run?.errorMessage).toContain('github_rate_limited');
    expect(ctx.github.created).toHaveLength(0);
  });

  it('does not retry non-retryable GitHub errors', async () => {
    ctx = await createTestApp();
    const runId = await queueAutoPostRun(ctx);
    ctx.github.createCommentFailures = [new GitHubApiError('Not Found', 'github_not_found', 404)];

    await drainWorker(ctx);
    const run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('failed');
    expect(run?.errorCode).toBe('github_not_found');
    expect(ctx.github.created).toHaveLength(0);
  });

  it('marks generator crashes as failed and publishes nothing', async () => {
    ctx = await createTestApp();
    const runId = await queueAutoPostRun(ctx);
    await drainWorker(ctx, {
      createGenerator: () => ({
        generate: async () => {
          throw new Error('generator exploded');
        },
      }),
    });
    const run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('failed');
    expect(run?.errorCode).toBe('generation_failed');
    expect(run?.errorMessage).toContain('generator exploded');
    expect(ctx.github.created).toHaveLength(0);
  });

  it('blocks generated content that contains secrets', async () => {
    ctx = await createTestApp();
    const runId = await queueAutoPostRun(ctx);
    await drainWorker(ctx, {
      createGenerator: () => ({
        generate: async () => ({
          body: 'Here you go: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          templateName: 'evil',
          fallbackUsed: false,
          provider: 'template',
        }),
      }),
    });
    const run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('blocked_sensitive');
    expect(run?.generatedReply).toBeNull();
    expect(run?.errorMessage).not.toContain('ghp_');
    expect(ctx.github.created).toHaveLength(0);
  });

  it('falls back to a draft when the permission lookup fails', async () => {
    ctx = await createTestApp();
    const runId = await queueAutoPostRun(ctx);
    ctx.github.failure = {
      method: 'getPermission',
      error: new GitHubApiError('permission endpoint down', 'github_request_failed', 500),
    };
    await drainWorker(ctx);
    const run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('drafted');
    expect(run?.reason).toBe('role_limited_to_draft');
    expect(ctx.github.created).toHaveLength(0);
  });

  it('re-checks dry-run right before publishing an approved run', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    seedRepo(ctx.store, { enabled: true, settings: { onIssueOpened: true, requireApproval: true } });
    const response = await postWebhook(ctx, { event: 'issues', payload: issuePayload() });
    const runId = response.json().runId;
    await drainWorker(ctx);
    expect(ctx.store.getRunById(runId)?.status).toBe('drafted');

    ctx.store.updateRun(runId, { status: 'approved', editedReply: 'Approved reply' });
    ctx.store.enqueueJob(runId, 'publish');
    ctx.store.updateGlobalSettings({ dryRun: true });

    await drainWorker(ctx);
    const run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('skipped');
    expect(run?.reason).toBe('dry_run_enabled');
    expect(ctx.github.created).toHaveLength(0);
  });

  it('skips instead of publishing when automation is turned off after an approval', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    seedRepo(ctx.store, { enabled: true, settings: { onIssueOpened: true, requireApproval: true } });
    const response = await postWebhook(ctx, { event: 'issues', payload: issuePayload() });
    const runId = response.json().runId;
    await drainWorker(ctx);

    ctx.store.updateRun(runId, { status: 'approved', editedReply: 'Approved reply' });
    ctx.store.enqueueJob(runId, 'publish');
    ctx.store.updateGlobalSettings({ automationEnabled: false });

    await drainWorker(ctx);
    const run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('skipped');
    expect(run?.reason).toBe('automation_disabled');
    expect(ctx.github.created).toHaveLength(0);
  });

  it('recovers an approved run through the retry endpoint', async () => {
    ctx = await createTestApp();
    const runId = await queueAutoPostRun(ctx);
    ctx.github.createCommentFailures = [
      new GitHubApiError('boom', 'github_server_error', 500),
      new GitHubApiError('boom', 'github_server_error', 500),
      new GitHubApiError('boom', 'github_server_error', 500),
    ];
    await drainWorker(ctx);
    await drainWorker(ctx, { now: () => new Date(Date.now() + 10_000) });
    await drainWorker(ctx, { now: () => new Date(Date.now() + 120_000) });
    expect(ctx.store.getRunById(runId)?.status).toBe('failed');

    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/retry`,
      headers: { authorization: 'Bearer test-admin-token-123456', 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(retry.statusCode).toBe(200);
    const recovered = ctx.store.getRunById(runId);
    expect(recovered?.status).toBe('received');
    expect(recovered?.errorCode).toBeNull();

    await drainWorker(ctx);
    const run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('posted');
    expect(ctx.github.created).toHaveLength(1);
  });
});
