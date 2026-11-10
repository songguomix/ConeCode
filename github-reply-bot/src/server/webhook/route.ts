import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config';
import type { CreateRunInput, Store } from '../db/store';
import type { RunStatus } from '../../shared/types';
import { normalizeWebhook, type NormalizedWebhook } from './parse';
import { verifySignature } from './signature';
import type { WorkerLogger } from '../worker/worker';

export interface WebhookDeps {
  store: Store;
  config: AppConfig;
  logger?: WorkerLogger;
}

function runInput(
  event: NormalizedWebhook,
  repoId: number,
  status: RunStatus,
  reason: string | null,
  eventPayload?: unknown
): CreateRunInput {
  return {
    deliveryId: event.deliveryId,
    dedupeKey: event.dedupeKey,
    eventType: event.eventName,
    action: event.action,
    triggerKind: event.trigger,
    labels: event.labels,
    repoId,
    issueNumber: event.issueNumber,
    prNumber: event.prNumber,
    actorLogin: event.actorLogin,
    actorIsBot: event.actorType === 'Bot',
    status,
    reason,
    eventPayload,
  };
}

function switchEnabled(store: Store, repoId: number, trigger: NormalizedWebhook['trigger']): boolean {
  const settings = store.getRepoSettings(repoId);
  switch (trigger) {
    case 'issue_opened':
      return settings.onIssueOpened;
    case 'issue_labeled':
      return settings.onIssueLabeled;
    case 'pr_opened':
      return settings.onPrOpened;
    case 'pr_labeled':
      return settings.onPrLabeled;
    case 'mention':
      return settings.onMention;
    default:
      return false;
  }
}

/**
 * Cheap, GitHub-free gates. Anything skipped here is recorded as a run with a
 * reason and never reaches the worker, so no content is read and no API call is
 * made while automation is off.
 */
function earlyDecision(
  store: Store,
  event: NormalizedWebhook,
  repoId: number,
  repoEnabled: boolean
): { status: RunStatus; reason: string } | null {
  const global = store.getGlobalSettings();
  if (!global.automationEnabled) return { status: 'skipped', reason: 'automation_disabled' };
  if (!repoEnabled) return { status: 'skipped', reason: 'repo_disabled' };
  if (event.trigger === 'other') return { status: 'ignored', reason: 'unsupported_action' };
  if (!switchEnabled(store, repoId, event.trigger)) {
    return { status: 'skipped', reason: `event_disabled:${event.trigger}` };
  }
  if (event.actorType === 'Bot') return { status: 'skipped', reason: 'bot_actor' };
  return null;
}

function syncInstallation(store: Store, event: NormalizedWebhook): void {
  if (event.action === 'deleted') {
    if (event.installationId) store.deleteInstallation(event.installationId);
    return;
  }
  if (!event.installationId) return;
  const installation = store.upsertInstallation(
    event.installationId,
    event.installationAccount ?? 'unknown'
  );
  for (const repo of event.repositories) {
    store.upsertRepository(installation.id, repo.githubId, repo.owner, repo.name);
  }
  for (const removedId of event.removedRepositoryIds) {
    store.removeRepositoryByGithubId(removedId);
  }
}

export function registerWebhookRoute(app: FastifyInstance, deps: WebhookDeps): void {
  const { store, config } = deps;

  app.post('/webhook', async (request, reply) => {
    const secret = config.github.webhookSecret;
    if (!secret) {
      request.log.error('Webhook rejected: GITHUB_WEBHOOK_SECRET is not configured');
      return reply.code(503).send({
        error: 'webhook_not_configured',
        message: '服务器未配置 GITHUB_WEBHOOK_SECRET，无法校验 webhook 签名。',
      });
    }

    const eventName = String(request.headers['x-github-event'] ?? 'unknown');
    const deliveryId = String(request.headers['x-github-delivery'] ?? '');
    const rawBody = request.rawBody;

    if (!verifySignature(secret, rawBody, request.headers['x-hub-signature-256'])) {
      store.addAudit({
        actor: 'github',
        action: 'webhook.rejected',
        detail: { event: eventName, deliveryId, reason: 'invalid_signature' },
      });
      request.log.warn({ event: eventName, deliveryId }, 'webhook_signature_rejected');
      return reply.code(401).send({
        error: 'invalid_signature',
        message: 'Webhook 签名校验失败，请求已拒绝且未创建任务。',
      });
    }

    if (!deliveryId) {
      return reply.code(400).send({ error: 'missing_delivery', message: '缺少 X-GitHub-Delivery 头' });
    }

    store.addAudit({
      actor: 'github',
      action: 'webhook.received',
      detail: { event: eventName, deliveryId },
    });

    if (eventName === 'ping') {
      return reply.code(202).send({ status: 'pong' });
    }

    const parsed = normalizeWebhook(eventName, deliveryId, request.body, {
      appSlug: config.github.appSlug,
    });
    if (!parsed.ok) {
      store.addAudit({
        actor: 'github',
        action: 'webhook.ignored',
        detail: { event: eventName, deliveryId, reason: parsed.reason },
      });
      return reply.code(202).send({ status: 'ignored', reason: parsed.reason });
    }
    const event = parsed.event;

    if (event.eventName === 'installation' || event.eventName === 'installation_repositories') {
      syncInstallation(store, event);
      store.addAudit({
        actor: 'github',
        action: 'installation.synced',
        detail: { action: event.action, installationId: event.installationId },
      });
      return reply.code(202).send({ status: 'installation_synced' });
    }

    if (!event.repo) {
      return reply.code(202).send({ status: 'ignored', reason: 'missing_repository' });
    }

    let repo = store.getRepositoryByGithubId(event.repo.githubId);
    if (!repo && event.installationId) {
      const installation = store.upsertInstallation(
        event.installationId,
        event.installationAccount ?? event.repo.owner
      );
      repo = store.upsertRepository(installation.id, event.repo.githubId, event.repo.owner, event.repo.name);
    }
    if (!repo) {
      store.addAudit({
        actor: 'github',
        action: 'webhook.ignored',
        detail: { deliveryId, reason: 'unknown_repository' },
      });
      return reply.code(202).send({ status: 'ignored', reason: 'unknown_repository' });
    }

    const decision = earlyDecision(store, event, repo.id, repo.repoEnabled);
    if (decision) {
      const { created, run } = store.createRun(runInput(event, repo.id, decision.status, decision.reason));
      if (created) {
        store.addAudit({
          runId: run.id,
          repoId: repo.id,
          actor: 'github',
          action: 'run.skipped',
          detail: { reason: decision.reason },
        });
      }
      return reply.code(202).send({
        status: decision.status === 'ignored' ? 'ignored' : 'skipped',
        reason: decision.reason,
        runId: run.id,
      });
    }

    const storePayload = store.getRepoSettings(repo.id).storeEventPayload;
    const { created, run } = store.createRun(
      runInput(event, repo.id, 'received', null, storePayload ? request.body : undefined),
      { enqueue: true, jobType: 'process' }
    );
    if (!created) {
      return reply.code(202).send({ status: 'duplicate', runId: run.id });
    }
    store.addAudit({
      runId: run.id,
      repoId: repo.id,
      actor: 'github',
      action: 'run.received',
      detail: { event: event.eventName, action: event.action, trigger: event.trigger },
    });
    return reply.code(202).send({ status: 'queued', runId: run.id });
  });
}
