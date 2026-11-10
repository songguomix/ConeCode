import { afterEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  commentPayload,
  createTestApp,
  drainWorker,
  enableAutomation,
  installationPayload,
  issuePayload,
  postWebhook,
  pullRequestPayload,
  seedRepo,
  type TestContext,
} from './helpers';
import { sampleIssue } from './fakeGithub';

let ctx: TestContext | null = null;

afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

describe('webhook intake', () => {
  it('rejects unsigned or wrongly signed payloads with 401 and creates no run', async () => {
    ctx = await createTestApp();
    seedRepo(ctx.store, { enabled: true, settings: { onIssueOpened: true } });
    enableAutomation(ctx.store);

    const response = await postWebhook(ctx, {
      event: 'issues',
      payload: issuePayload(),
      signature: `sha256=${'0'.repeat(64)}`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'invalid_signature' });
    expect(ctx.store.listRuns({ page: 1, pageSize: 20 }).total).toBe(0);
    expect(ctx.github.calls).toEqual([]);

    const missing = await postWebhook(ctx, { event: 'issues', payload: issuePayload(), signature: null });
    expect(missing.statusCode).toBe(401);
    expect(ctx.store.listRuns({ page: 1, pageSize: 20 }).total).toBe(0);
  });

  it('answers 503 with a clear error when the webhook secret is not configured', async () => {
    ctx = await createTestApp({ env: { GITHUB_WEBHOOK_SECRET: undefined } });
    const response = await postWebhook(ctx, { event: 'issues', payload: issuePayload() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'webhook_not_configured' });
  });

  it('records skipped runs while automation is globally off, without touching GitHub', async () => {
    ctx = await createTestApp();
    seedRepo(ctx.store, { enabled: true, settings: { onIssueOpened: true } });

    const response = await postWebhook(ctx, { event: 'issues', payload: issuePayload() });
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body).toMatchObject({ status: 'skipped', reason: 'automation_disabled' });

    const run = ctx.store.getRunById(body.runId);
    expect(run?.status).toBe('skipped');
    expect(run?.reason).toBe('automation_disabled');
    expect(ctx.github.calls).toEqual([]);
    const processed = await drainWorker(ctx);
    expect(processed).toBe(0);
  });

  it('skips disabled repositories and disabled event switches with explicit reasons', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    seedRepo(ctx.store, { enabled: false });

    const repoOff = await postWebhook(ctx, { event: 'issues', payload: issuePayload() });
    expect(repoOff.json()).toMatchObject({ status: 'skipped', reason: 'repo_disabled' });

    ctx.store.setRepoEnabled(ctx.store.listRepositories().items[0].id, true);
    const eventOff = await postWebhook(ctx, {
      event: 'issues',
      payload: issuePayload({
        issue: {
          number: 8,
          title: 'Second report: slow startup',
          body: 'The app takes 30 seconds to start. Version 1.2.3.',
          user: { login: 'alice', type: 'User' },
          labels: [{ name: 'bug' }],
        },
      }),
      delivery: 'delivery-event-off',
    });
    expect(eventOff.json()).toMatchObject({ status: 'skipped', reason: 'event_disabled:issue_opened' });
    expect(ctx.github.calls).toEqual([]);
  });

  it('ignores actions that have no configured trigger', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    seedRepo(ctx.store, { enabled: true, settings: { onIssueOpened: true } });
    const response = await postWebhook(ctx, {
      event: 'issues',
      payload: issuePayload({ action: 'edited' }),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'ignored', reason: 'unsupported_action' });
  });

  it('never triggers on bot accounts', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    seedRepo(ctx.store, { enabled: true, settings: { onIssueOpened: true } });
    const response = await postWebhook(ctx, {
      event: 'issues',
      payload: issuePayload({
        issue: {
          number: 7,
          title: 'Bot issue',
          body: 'body',
          user: { login: 'dependabot[bot]', type: 'Bot' },
          labels: [],
        },
      }),
    });
    expect(response.json()).toMatchObject({ status: 'skipped', reason: 'bot_actor' });
  });

  it('syncs installation events and removes repositories on uninstall', async () => {
    ctx = await createTestApp();
    const created = await postWebhook(ctx, {
      event: 'installation',
      payload: installationPayload('created'),
    });
    expect(created.statusCode).toBe(202);
    const repo = ctx.store.getRepositoryByGithubId(777);
    expect(repo).not.toBeNull();
    expect(repo?.repoEnabled).toBe(false);

    const removed = await postWebhook(ctx, {
      event: 'installation',
      payload: installationPayload('deleted'),
    });
    expect(removed.statusCode).toBe(202);
    expect(ctx.store.getRepositoryByGithubId(777)).toBeNull();
  });
});

describe('draft approval flow', () => {
  it('drafts, then posts exactly one comment after approval', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    seedRepo(ctx.store, {
      enabled: true,
      settings: { onIssueOpened: true, requireApproval: true, autoPostEnabled: false },
    });

    const response = await postWebhook(ctx, { event: 'issues', payload: issuePayload(), delivery: 'delivery-draft-1' });
    expect(response.statusCode).toBe(202);
    const { runId } = response.json();
    await drainWorker(ctx);

    const drafted = ctx.store.getRunById(runId);
    expect(drafted?.status).toBe('drafted');
    expect(drafted?.generatedReply).toBeTruthy();
    expect(ctx.github.created).toHaveLength(0);
    expect(ctx.github.calls).toContain('getIssue');
    expect(ctx.github.calls).toContain('listComments');

    const approval = await ctx.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: authHeader(),
      payload: JSON.stringify({ reply: 'Thanks alice, we are looking into the crash.' }),
    });
    expect(approval.statusCode).toBe(200);
    expect(approval.json().run.status).toBe('approved');

    await drainWorker(ctx);
    const posted = ctx.store.getRunById(runId);
    expect(posted?.status).toBe('posted');
    expect(posted?.postedCommentId).toBeGreaterThan(0);
    expect(posted?.reason).toBe('approved_and_posted');
    expect(ctx.github.created).toHaveLength(1);
    expect(ctx.github.created[0].body).toContain('Thanks alice');
  });

  it('auto-posts for maintainers when approval is off', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    ctx.github.permissions = { alice: 'maintain' };
    seedRepo(ctx.store, {
      enabled: true,
      settings: { onIssueOpened: true, autoPostEnabled: true, requireApproval: false },
    });

    const response = await postWebhook(ctx, { event: 'issues', payload: issuePayload() });
    const { runId } = response.json();
    await drainWorker(ctx);

    const run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('posted');
    expect(run?.reason).toBe('auto_posted');
    expect(ctx.github.created).toHaveLength(1);
  });

  it('never posts in dry-run mode and refuses approval', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store, { dryRun: true });
    ctx.github.permissions = { alice: 'admin' };
    seedRepo(ctx.store, {
      enabled: true,
      settings: { onIssueOpened: true, autoPostEnabled: true, requireApproval: false },
    });

    const response = await postWebhook(ctx, { event: 'issues', payload: issuePayload() });
    const { runId } = response.json();
    await drainWorker(ctx);

    const run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('drafted');
    expect(run?.reason).toBe('dry_run');
    expect(ctx.github.created).toHaveLength(0);

    const approval = await ctx.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: authHeader(),
      payload: JSON.stringify({}),
    });
    expect(approval.statusCode).toBe(409);
    expect(approval.json()).toMatchObject({ error: 'dry_run_enabled' });
  });

  it('deduplicates repeated deliveries and identical content hashes', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    ctx.github.permissions = { alice: 'maintain' };
    seedRepo(ctx.store, {
      enabled: true,
      settings: { onIssueOpened: true, autoPostEnabled: true, requireApproval: false },
    });

    const first = await postWebhook(ctx, { event: 'issues', payload: issuePayload(), delivery: 'delivery-dup-1' });
    const { runId } = first.json();
    await drainWorker(ctx);
    expect(ctx.github.created).toHaveLength(1);

    const sameDelivery = await postWebhook(ctx, { event: 'issues', payload: issuePayload(), delivery: 'delivery-dup-1' });
    expect(sameDelivery.json()).toMatchObject({ status: 'duplicate', runId });

    const sameContent = await postWebhook(ctx, { event: 'issues', payload: issuePayload(), delivery: 'delivery-dup-2' });
    expect(sameContent.json()).toMatchObject({ status: 'duplicate', runId });

    await drainWorker(ctx);
    expect(ctx.github.created).toHaveLength(1);
    expect(ctx.store.listRuns({ page: 1, pageSize: 20 }).total).toBe(1);
  });
});

describe('policy gates through the worker', () => {
  it('skips over the hourly rate limit', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    ctx.github.permissions = { alice: 'maintain' };
    const { repo } = seedRepo(ctx.store, {
      enabled: true,
      settings: { onIssueOpened: true, autoPostEnabled: true, requireApproval: false, rateLimitPerHour: 1 },
    });
    ctx.store.createRun(
      {
        deliveryId: 'previous-delivery',
        dedupeKey: 'previous-dedupe',
        eventType: 'issues',
        action: 'opened',
        triggerKind: 'issue_opened',
        labels: ['bug'],
        repoId: repo.id,
        issueNumber: 3,
        prNumber: null,
        actorLogin: 'alice',
        actorIsBot: false,
        status: 'posted',
        reason: 'auto_posted',
      },
      { enqueue: false }
    );

    const response = await postWebhook(ctx, { event: 'issues', payload: issuePayload(), delivery: 'delivery-rate' });
    const { runId } = response.json();
    await drainWorker(ctx);
    const run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('skipped');
    expect(run?.reason).toBe('rate_limited');
    expect(ctx.github.created).toHaveLength(0);
  });

  it('stores the raw webhook payload only when explicitly enabled', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    const { repo } = seedRepo(ctx.store, { enabled: true, settings: { onIssueOpened: true } });

    const off = await postWebhook(ctx, { event: 'issues', payload: issuePayload(), delivery: 'payload-off' });
    await drainWorker(ctx);
    expect(ctx.store.getRunById(off.json().runId)?.eventPayload).toBeNull();

    ctx.store.updateRepoSettings(repo.id, { storeEventPayload: true });
    const on = await postWebhook(ctx, {
      event: 'issues',
      payload: issuePayload({
        issue: {
          number: 8,
          title: 'Second report',
          body: 'Another body for the payload test.',
          user: { login: 'alice', type: 'User' },
          labels: [{ name: 'bug' }],
        },
      }),
      delivery: 'payload-on',
    });
    const run = ctx.store.getRunById(on.json().runId);
    expect(run?.eventPayload).toMatchObject({ action: 'opened' });
  });

  it('limits PR file reads to max_changed_files and stores no diff', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    seedRepo(ctx.store, { enabled: true, settings: { onPrOpened: true, maxChangedFiles: 5 } });
    ctx.github.pullRequest = sampleIssue({
      number: 9,
      title: 'Add caching layer',
      isPullRequest: true,
      changedFiles: 40,
    });
    ctx.github.files = Array.from({ length: 10 }, (_, index) => ({
      filename: `src/file-${index}.ts`,
      status: 'modified',
      additions: index,
      deletions: 1,
    }));

    const response = await postWebhook(ctx, { event: 'pull_request', payload: pullRequestPayload() });
    const { runId } = response.json();
    await drainWorker(ctx);

    const run = ctx.store.getRunById(runId);
    expect(run?.status).toBe('drafted');
    const summary = run?.contextSummary as { files: unknown[]; totalChangedFiles: number };
    expect(summary.files).toHaveLength(5);
    expect(summary.totalChangedFiles).toBe(40);
    expect(ctx.github.lastPullFilesLimit).toBe(5);
    expect(JSON.stringify(summary)).not.toContain('diff');
  });

  it('handles @mentions only when enabled and the slug is configured', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    seedRepo(ctx.store, {
      enabled: true,
      settings: { onMention: true, mentionTriggerEnabled: true, requireApproval: true },
    });

    const response = await postWebhook(ctx, {
      event: 'issue_comment',
      payload: commentPayload('Hey @reply-bot could you take a look?'),
    });
    const { runId } = response.json();
    await drainWorker(ctx);
    const run = ctx.store.getRunById(runId);
    expect(run?.triggerKind).toBe('mention');
    expect(run?.status).toBe('drafted');
    expect(run?.generatedReply).toContain('#7');
  });

  it('ignores comments that do not mention the bot', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    seedRepo(ctx.store, { enabled: true, settings: { onMention: true, mentionTriggerEnabled: true } });
    const response = await postWebhook(ctx, {
      event: 'issue_comment',
      payload: commentPayload('Just a normal comment'),
    });
    expect(response.json()).toMatchObject({ status: 'ignored', reason: 'unsupported_action' });
  });

  it('records review comments without acting on them', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    seedRepo(ctx.store, { enabled: true, settings: { onPrOpened: true } });
    const response = await postWebhook(ctx, {
      event: 'pull_request_review_comment',
      payload: {
        action: 'created',
        pull_request: { number: 9, title: 'PR' },
        comment: { id: 555, body: 'nit: rename this', user: { login: 'bob', type: 'User' } },
        repository: { id: 500, name: 'widgets', owner: { login: 'acme' } },
        installation: { id: 9001, account: { login: 'acme' } },
        sender: { login: 'bob', type: 'User' },
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'ignored', reason: 'unsupported_action' });
  });
});
