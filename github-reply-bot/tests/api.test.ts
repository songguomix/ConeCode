import { afterEach, describe, expect, it } from 'vitest';
import { authHeader, createTestApp, drainWorker, enableAutomation, issuePayload, postWebhook, seedRepo, TEST_ADMIN_TOKEN, type TestContext } from './helpers';

let ctx: TestContext | null = null;

afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

describe('admin authentication', () => {
  it('rejects unauthenticated API access with 401', async () => {
    ctx = await createTestApp();
    for (const url of ['/api/overview', '/api/repos', '/api/runs', '/api/settings', '/api/templates', '/api/audit']) {
      const response = await ctx.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('disables the admin API with 503 when ADMIN_TOKEN is missing', async () => {
    ctx = await createTestApp({ env: { ADMIN_TOKEN: undefined } });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token: 'anything' }),
    });
    expect(login.statusCode).toBe(503);
    expect(login.json()).toMatchObject({ error: 'admin_token_not_configured' });
    const overview = await ctx.app.inject({ method: 'GET', url: '/api/overview', headers: authHeader() });
    expect(overview.statusCode).toBe(503);
  });

  it('logs in with the configured token and rejects wrong tokens', async () => {
    ctx = await createTestApp();
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token: 'wrong-token' }),
    });
    expect(wrong.statusCode).toBe(401);

    const malformed = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(malformed.statusCode).toBe(400);

    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token: TEST_ADMIN_TOKEN }),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
  });
});

describe('overview, settings and repositories API', () => {
  it('returns default-safe overview and settings', async () => {
    ctx = await createTestApp();
    const overview = await ctx.app.inject({ method: 'GET', url: '/api/overview', headers: authHeader() });
    expect(overview.statusCode).toBe(200);
    const body = overview.json().overview;
    expect(body.status.automationEnabled).toBe(false);
    expect(body.status.dryRun).toBe(true);
    expect(body.counts.repositories).toBe(0);
    expect(body.status.githubConfigured).toBe(true);
    expect(body.status.dryRun).toBe(true);

    const settings = await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: authHeader() });
    expect(settings.json().settings).toMatchObject({ automationEnabled: false, dryRun: true, generatorProvider: 'template' });
  });

  it('validates global settings and refuses http_llm without an endpoint', async () => {
    ctx = await createTestApp();
    const badRetention = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeader(),
      payload: JSON.stringify({ retentionDays: 0 }),
    });
    expect(badRetention.statusCode).toBe(400);

    const noEndpoint = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeader(),
      payload: JSON.stringify({ generatorProvider: 'http_llm' }),
    });
    expect(noEndpoint.statusCode).toBe(400);
    expect(noEndpoint.json()).toMatchObject({ error: 'llm_not_configured' });

    const ok = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeader(),
      payload: JSON.stringify({ automationEnabled: true, dryRun: false, retentionDays: 7 }),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings).toMatchObject({ automationEnabled: true, dryRun: false, retentionDays: 7 });
  });

  it('accepts http_llm once an endpoint is configured', async () => {
    ctx = await createTestApp({ env: { LLM_ENDPOINT: 'https://llm.example.test/v1/chat/completions' } });
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeader(),
      payload: JSON.stringify({ generatorProvider: 'http_llm' }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.generatorProvider).toBe('http_llm');
  });

  it('lists repositories and toggles them', async () => {
    ctx = await createTestApp();
    const { repo } = seedRepo(ctx.store);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/repos', headers: authHeader() });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].repoEnabled).toBe(false);

    const enable = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/repos/${repo.id}`,
      headers: authHeader(),
      payload: JSON.stringify({ repoEnabled: true }),
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().repo.repoEnabled).toBe(true);

    const missing = await ctx.app.inject({ method: 'GET', url: '/api/repos/999', headers: authHeader() });
    expect(missing.statusCode).toBe(404);
  });

  it('enforces repository setting ranges and mutual exclusion', async () => {
    ctx = await createTestApp();
    const { repo } = seedRepo(ctx.store);
    const url = `/api/repos/${repo.id}/settings`;

    const range = await ctx.app.inject({
      method: 'PUT',
      url,
      headers: authHeader(),
      payload: JSON.stringify({ rateLimitPerHour: 0 }),
    });
    expect(range.statusCode).toBe(400);

    const conflict = await ctx.app.inject({
      method: 'PUT',
      url,
      headers: authHeader(),
      payload: JSON.stringify({ autoPostEnabled: true, requireApproval: true }),
    });
    expect(conflict.statusCode).toBe(400);
    expect(conflict.json()).toMatchObject({ error: 'invalid_settings' });

    const badZone = await ctx.app.inject({
      method: 'PUT',
      url,
      headers: authHeader(),
      payload: JSON.stringify({ quietHoursEnabled: true, quietHoursTimezone: 'Not/AZone' }),
    });
    expect(badZone.statusCode).toBe(400);

    const badTemplate = await ctx.app.inject({
      method: 'PUT',
      url,
      headers: authHeader(),
      payload: JSON.stringify({ templateId: 9999 }),
    });
    expect(badTemplate.statusCode).toBe(400);

    const ok = await ctx.app.inject({
      method: 'PUT',
      url,
      headers: authHeader(),
      payload: JSON.stringify({ onIssueOpened: true, triggerLabels: ['bot-reply'], maxChangedFiles: 5 }),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings).toMatchObject({ onIssueOpened: true, triggerLabels: ['bot-reply'], maxChangedFiles: 5 });
  });
});

describe('runs API and state machine', () => {
  it('lists and filters runs with pagination metadata', async () => {
    ctx = await createTestApp();
    const { repo } = seedRepo(ctx.store);
    for (const [index, status] of (['drafted', 'posted', 'drafted'] as const).entries()) {
      ctx.store.createRun({
        deliveryId: `delivery-list-${index}`,
        dedupeKey: `dedupe-list-${index}`,
        eventType: 'issues',
        action: 'opened',
        triggerKind: 'issue_opened',
        labels: ['bug'],
        repoId: repo.id,
        issueNumber: index + 1,
        prNumber: null,
        actorLogin: 'alice',
        actorIsBot: false,
        status,
        reason: 'test',
      });
    }
    const listed = await ctx.app.inject({ method: 'GET', url: '/api/runs?page=1&pageSize=2', headers: authHeader() });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(listed.json().items).toHaveLength(2);

    const filtered = await ctx.app.inject({ method: 'GET', url: '/api/runs?status=drafted', headers: authHeader() });
    expect(filtered.json().total).toBe(2);

    const invalid = await ctx.app.inject({ method: 'GET', url: '/api/runs?status=nope', headers: authHeader() });
    expect(invalid.statusCode).toBe(400);
  });

  it('returns run detail with jobs and audit entries', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    seedRepo(ctx.store, { enabled: true, settings: { onIssueOpened: true } });
    const queued = await postWebhook(ctx, { event: 'issues', payload: issuePayload() });
    const { runId } = queued.json();
    await drainWorker(ctx);

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: authHeader() });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().run.id).toBe(runId);
    expect(Array.isArray(detail.json().jobs)).toBe(true);
    expect(detail.json().jobs.length).toBeGreaterThan(0);
    expect(Array.isArray(detail.json().audit)).toBe(true);
  });

  it('rejects illegal state transitions with 409', async () => {
    ctx = await createTestApp();
    const { repo } = seedRepo(ctx.store);
    const run = ctx.store.createRun({
      deliveryId: 'delivery-state',
      dedupeKey: 'dedupe-state',
      eventType: 'issues',
      action: 'opened',
      triggerKind: 'issue_opened',
      labels: ['bug'],
      repoId: repo.id,
      issueNumber: 1,
      prNumber: null,
      actorLogin: 'alice',
      actorIsBot: false,
      status: 'received',
      reason: null,
    }).run;

    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/approve`,
      headers: authHeader(),
      payload: JSON.stringify({}),
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toMatchObject({ error: 'invalid_transition' });

    const reject = await ctx.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/reject`,
      headers: authHeader(),
      payload: JSON.stringify({}),
    });
    expect(reject.statusCode).toBe(409);

    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/retry`,
      headers: authHeader(),
      payload: JSON.stringify({}),
    });
    expect(retry.statusCode).toBe(409);
  });

  it('refuses to approve a reply containing secrets', async () => {
    ctx = await createTestApp();
    enableAutomation(ctx.store);
    seedRepo(ctx.store, { enabled: true, settings: { onIssueOpened: true } });
    const queued = await postWebhook(ctx, { event: 'issues', payload: issuePayload() });
    const { runId } = queued.json();
    await drainWorker(ctx);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: authHeader(),
      payload: JSON.stringify({ reply: 'token is ghp_abcdefghijklmnopqrstuvwxyz0123456789' }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'blocked_sensitive' });
    expect(ctx.store.getRunById(runId)?.status).toBe('blocked_sensitive');
    expect(ctx.github.created).toHaveLength(0);
  });

  it('rejects with 404 for unknown runs', async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({ method: 'GET', url: '/api/runs/4242', headers: authHeader() });
    expect(response.statusCode).toBe(404);
  });
});

describe('templates and audit API', () => {
  it('lists builtin templates and supports CRUD on custom templates', async () => {
    ctx = await createTestApp();
    const listed = await ctx.app.inject({ method: 'GET', url: '/api/templates', headers: authHeader() });
    expect(listed.json().items.length).toBe(4);
    const builtin = listed.json().items.find((item: { isBuiltin: boolean }) => item.isBuiltin);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/templates',
      headers: authHeader(),
      payload: JSON.stringify({ name: 'Custom', body: 'Hi {{author}}' }),
    });
    expect(created.statusCode).toBe(201);
    const templateId = created.json().template.id;

    const updated = await ctx.app.inject({
      method: 'PUT',
      url: `/api/templates/${templateId}`,
      headers: authHeader(),
      payload: JSON.stringify({ body: 'Hello {{author}}' }),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().template.body).toBe('Hello {{author}}');

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/templates/${templateId}`,
      headers: authHeader(),
    });
    expect(deleted.statusCode).toBe(204);

    const deleteBuiltin = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/templates/${builtin.id}`,
      headers: authHeader(),
    });
    expect(deleteBuiltin.statusCode).toBe(409);
  });

  it('exposes audit entries and webhook health', async () => {
    ctx = await createTestApp();
    seedRepo(ctx.store, { enabled: true });
    await postWebhook(ctx, { event: 'issues', payload: issuePayload(), signature: `sha256=${'1'.repeat(64)}` });

    const audit = await ctx.app.inject({ method: 'GET', url: '/api/audit?limit=10', headers: authHeader() });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items.length).toBeGreaterThan(0);

    const emitted = await postWebhook(ctx, { event: 'issues', payload: issuePayload() });
    expect(emitted.statusCode).toBe(202);
    const overview = await ctx.app.inject({ method: 'GET', url: '/api/overview', headers: authHeader() });
    expect(overview.json().overview.webhook.lastReceivedAt).not.toBeNull();
    expect(overview.json().overview.status.webhookConfigured).toBe(true);
  });
});
