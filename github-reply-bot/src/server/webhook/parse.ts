import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TriggerKind } from '../../shared/types';

const userSchema = z
  .object({ login: z.string(), type: z.string().optional() })
  .passthrough();

const labelSchema = z.union([
  z.string(),
  z.object({ name: z.string() }).passthrough(),
]);

const repoPayloadSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    owner: z.object({ login: z.string() }).passthrough(),
    full_name: z.string().optional(),
  })
  .passthrough();

const issueSchema = z
  .object({
    number: z.number(),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    user: userSchema.optional(),
    labels: z.array(labelSchema).optional(),
    pull_request: z.unknown().optional(),
  })
  .passthrough();

const pullRequestSchema = z
  .object({
    number: z.number(),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    user: userSchema.optional(),
    labels: z.array(labelSchema).optional(),
  })
  .passthrough();

const commentSchema = z
  .object({
    id: z.number(),
    body: z.string().nullable().optional(),
    user: userSchema.optional(),
  })
  .passthrough();

const installationSchema = z
  .object({
    id: z.number(),
    account: z.object({ login: z.string() }).passthrough().optional(),
  })
  .passthrough();

const baseSchema = z
  .object({
    action: z.string(),
    repository: repoPayloadSchema.optional(),
    sender: userSchema.optional(),
    installation: installationSchema.optional(),
    label: z.object({ name: z.string() }).passthrough().optional(),
  })
  .passthrough();

export type WebhookEventName =
  | 'issues'
  | 'issue_comment'
  | 'pull_request'
  | 'pull_request_review_comment'
  | 'installation'
  | 'installation_repositories'
  | 'ping'
  | 'unknown';

export interface NormalizedRepo {
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
}

export interface InstallationRepoRef {
  githubId: number;
  owner: string;
  name: string;
}

export interface NormalizedWebhook {
  eventName: WebhookEventName;
  action: string;
  deliveryId: string;
  installationId: number | null;
  installationAccount: string | null;
  repo: NormalizedRepo | null;
  issueNumber: number | null;
  prNumber: number | null;
  actorLogin: string;
  actorType: string;
  labels: string[];
  title: string | null;
  body: string | null;
  commentId: number | null;
  commentBody: string | null;
  trigger: TriggerKind;
  dedupeKey: string;
  repositories: InstallationRepoRef[];
  removedRepositoryIds: number[];
}

export type ParseResult =
  | { ok: true; event: NormalizedWebhook }
  | { ok: false; reason: string };

function contentHash(value: string | null | undefined): string {
  return createHash('sha256').update(value ?? '').digest('hex').slice(0, 16);
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const label of value) {
    if (typeof label === 'string') names.push(label);
    else if (label && typeof label === 'object' && typeof (label as { name?: unknown }).name === 'string') {
      names.push((label as { name: string }).name);
    }
  }
  return names;
}

export function mentionsSlug(text: string | null | undefined, slug: string | null): boolean {
  if (!text || !slug) return false;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])@${escaped}(?![\\w-])`, 'i').test(text);
}

function repoFrom(value: z.infer<typeof repoPayloadSchema> | undefined): NormalizedRepo | null {
  if (!value) return null;
  return {
    githubId: value.id,
    owner: value.owner.login,
    name: value.name,
    fullName: value.full_name ?? `${value.owner.login}/${value.name}`,
  };
}

/** Validates the parts of a webhook payload this service relies on. */
export function normalizeWebhook(
  eventName: string,
  deliveryId: string,
  rawPayload: unknown,
  options: { appSlug: string | null }
): ParseResult {
  if (eventName === 'ping') {
    return {
      ok: true,
      event: {
        eventName: 'ping',
        action: 'ping',
        deliveryId,
        installationId: null,
        installationAccount: null,
        repo: null,
        issueNumber: null,
        prNumber: null,
        actorLogin: 'github',
        actorType: 'User',
        labels: [],
        title: null,
        body: null,
        commentId: null,
        commentBody: null,
        trigger: 'other',
        dedupeKey: `ping:${deliveryId}`,
        repositories: [],
        removedRepositoryIds: [],
      },
    };
  }

  if (eventName === 'installation' || eventName === 'installation_repositories') {
    const parsed = baseSchema
      .extend({
        repositories: z.array(repoPayloadSchema).optional(),
        repositories_added: z.array(repoPayloadSchema).optional(),
        repositories_removed: z.array(z.object({ id: z.number() }).passthrough()).optional(),
        installation: installationSchema,
      })
      .safeParse(rawPayload);
    if (!parsed.success) return { ok: false, reason: 'invalid_payload' };
    const payload = parsed.data;
    if (!payload.installation) return { ok: false, reason: 'missing_installation' };
    const repositories = [
      ...(payload.repositories ?? []),
      ...(payload.repositories_added ?? []),
    ].map((repo) => ({
      githubId: repo.id,
      owner: repo.owner.login,
      name: repo.name,
    }));
    return {
      ok: true,
      event: {
        eventName: eventName as WebhookEventName,
        action: payload.action,
        deliveryId,
        installationId: payload.installation.id,
        installationAccount: payload.installation.account?.login ?? null,
        repo: null,
        issueNumber: null,
        prNumber: null,
        actorLogin: payload.sender?.login ?? 'github',
        actorType: payload.sender?.type ?? 'User',
        labels: [],
        title: null,
        body: null,
        commentId: null,
        commentBody: null,
        trigger: 'other',
        dedupeKey: `installation:${payload.installation.id}:${payload.action}:${contentHash(
          JSON.stringify(repositories.map((r) => r.githubId))
        )}`,
        repositories,
        removedRepositoryIds: (payload.repositories_removed ?? []).map((repo) => repo.id),
      },
    };
  }

  if (!['issues', 'issue_comment', 'pull_request', 'pull_request_review_comment'].includes(eventName)) {
    return { ok: false, reason: 'unsupported_event' };
  }

  const parsed = baseSchema
    .extend({
      issue: issueSchema.optional(),
      pull_request: pullRequestSchema.optional(),
      comment: commentSchema.optional(),
    })
    .safeParse(rawPayload);
  if (!parsed.success) {
    return { ok: false, reason: `invalid_payload:${parsed.error.issues[0]?.path.join('.') ?? 'unknown'}` };
  }
  const payload = parsed.data;
  const repo = repoFrom(payload.repository);
  if (!repo) return { ok: false, reason: 'missing_repository' };

  const isPullRequest = eventName === 'pull_request' || eventName === 'pull_request_review_comment';
  const subject = isPullRequest ? payload.pull_request : payload.issue;
  if (!subject) return { ok: false, reason: 'missing_subject' };

  const comment = payload.comment;
  const commentBody = comment?.body ?? null;
  const labels = labelNames(subject.labels);
  const labelName = payload.label?.name ?? null;

  let trigger: TriggerKind = 'other';
  if (eventName === 'issues' && payload.action === 'opened') trigger = 'issue_opened';
  if (eventName === 'issues' && payload.action === 'labeled') trigger = 'issue_labeled';
  if (eventName === 'pull_request' && payload.action === 'opened') trigger = 'pr_opened';
  if (eventName === 'pull_request' && payload.action === 'labeled') trigger = 'pr_labeled';
  if (eventName === 'issue_comment' && payload.action === 'created') {
    trigger = mentionsSlug(commentBody, options.appSlug) ? 'mention' : 'other';
  }

  const scope = comment ? `comment:${comment.id}` : labelName ? `label:${labelName}` : payload.action;
  const dedupeKey = `${repo.githubId}:${eventName}:${payload.action}:${scope}:${contentHash(
    `${commentBody ?? ''}|${subject.title ?? ''}|${subject.body ?? ''}`
  )}`;

  const issueNumber =
    eventName === 'issue_comment' ? (payload.issue?.number ?? null) : isPullRequest ? null : (subject.number ?? null);
  const prNumber =
    isPullRequest || (eventName === 'issue_comment' && payload.issue?.pull_request)
      ? (subject.number ?? null)
      : null;

  return {
    ok: true,
    event: {
      eventName: eventName as WebhookEventName,
      action: payload.action,
      deliveryId,
      installationId: payload.installation?.id ?? null,
      installationAccount: payload.installation?.account?.login ?? null,
      repo,
      issueNumber: eventName === 'issue_comment' ? issueNumber : isPullRequest ? null : subject.number,
      prNumber,
      actorLogin: comment?.user?.login ?? subject.user?.login ?? payload.sender?.login ?? 'unknown',
      actorType: comment?.user?.type ?? subject.user?.type ?? payload.sender?.type ?? 'User',
      labels,
      title: subject.title ?? null,
      body: subject.body ?? null,
      commentId: comment?.id ?? null,
      commentBody,
      trigger,
      dedupeKey,
      repositories: [],
      removedRepositoryIds: [],
    },
  };
}
