import type { AppConfig } from '../config';
import type { Store } from '../db/store';
import { canPublishNow, evaluatePolicy } from '../policy/engine';
import { sanitizeReply } from '../safety/filter';
import { createGenerator, GeneratorConfigError } from '../generator';
import type { ReplyGenerator } from '../generator/types';
import type { GitHubApi, RepoRef } from '../github/types';
import { toGitHubApiError } from '../github/types';
import type {
  GeneratorProvider,
  GlobalSettingsDto,
  JobDto,
  RepoSettingsDto,
  RepositoryDto,
  RunDto,
} from '../../shared/types';
import { hoursAgo } from '../util/time';
import { buildContext } from './context';

export interface WorkerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface WorkerDeps {
  store: Store;
  github: GitHubApi;
  config: AppConfig;
  logger?: WorkerLogger;
  now?: () => Date;
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  createGenerator?: (provider: GeneratorProvider, templateBody?: string) => ReplyGenerator;
}

function repoRef(repo: RepositoryDto): RepoRef {
  return { owner: repo.owner, name: repo.name };
}

function makeGenerator(deps: WorkerDeps, provider: GeneratorProvider, templateBody?: string): ReplyGenerator {
  if (deps.createGenerator) return deps.createGenerator(provider, templateBody);
  return createGenerator({ provider, templateBody, llm: deps.config.llm });
}

function audit(
  deps: WorkerDeps,
  run: RunDto,
  action: string,
  detail?: unknown,
  actor = 'system'
): void {
  deps.store.addAudit({ runId: run.id, repoId: run.repoId, actor, action, detail });
}

function skipRun(deps: WorkerDeps, run: RunDto, reason: string): void {
  deps.store.updateRun(run.id, { status: 'skipped', reason });
  audit(deps, run, 'run.skipped', { reason });
}

function failRun(deps: WorkerDeps, run: RunDto, code: string, message: string): void {
  deps.store.updateRun(run.id, {
    status: 'failed',
    errorCode: code,
    errorMessage: message.slice(0, 500),
    reason: 'failed',
  });
  audit(deps, run, 'run.failed', { code, message: message.slice(0, 200) });
}

function switchForRun(settings: RepoSettingsDto, run: RunDto): boolean {
  switch (run.triggerKind) {
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

/** Re-checks global, repo and event switches before doing any GitHub work. */
function gate(
  deps: WorkerDeps,
  job: JobDto,
  run: RunDto,
  repo: RepositoryDto,
  settings: RepoSettingsDto,
  global: GlobalSettingsDto
): { ok: true } | { ok: false; reason: string } {
  if (!global.automationEnabled) return { ok: false, reason: 'automation_disabled' };
  if (!repo.repoEnabled) return { ok: false, reason: 'repo_disabled' };
  if (run.triggerKind !== 'other' && !switchForRun(settings, run)) {
    return { ok: false, reason: `event_disabled:${run.triggerKind}` };
  }
  if (run.triggerKind === 'other') return { ok: false, reason: 'unsupported_action' };

  if (job.type === 'publish') {
    if (run.postedCommentId !== null) return { ok: false, reason: 'already_posted' };
    if (!['approved', 'retrying'].includes(run.status)) {
      return { ok: false, reason: `run_not_approvable:${run.status}` };
    }
    if (global.dryRun) return { ok: false, reason: 'dry_run_enabled' };
    return { ok: true };
  }

  if (!['received', 'retrying'].includes(run.status)) {
    return { ok: false, reason: `run_not_processable:${run.status}` };
  }
  if (run.dedupeKey && deps.store.hasPostedRunForDedupeKey(run.dedupeKey)) {
    return { ok: false, reason: 'duplicate_reply' };
  }
  return { ok: true };
}

function scheduleRetryOrFail(
  deps: WorkerDeps,
  job: JobDto,
  run: RunDto,
  error: unknown,
  now: Date,
  phase: string
): void {
  const apiError = toGitHubApiError(error);
  const maxAttempts = deps.maxAttempts ?? 3;
  const message = `[${phase}] ${apiError.code}: ${apiError.message}`.slice(0, 500);
  if (apiError.retryable && job.attempts < maxAttempts) {
    const delay = deps.backoffMs
      ? deps.backoffMs(job.attempts)
      : 30_000 * 2 ** Math.max(job.attempts - 1, 0);
    deps.store.updateRun(run.id, {
      status: 'retrying',
      reason: 'retry_scheduled',
      errorCode: apiError.code,
      errorMessage: message,
      attempts: job.attempts,
    });
    deps.store.rescheduleJob(job.id, new Date(now.getTime() + delay).toISOString(), message);
    audit(deps, run, 'run.retry_scheduled', { attempt: job.attempts, delayMs: delay, message });
    deps.logger?.warn({ runId: run.id, attempt: job.attempts, delay, message }, 'run_retry_scheduled');
    return;
  }
  deps.store.updateRun(run.id, {
    status: 'failed',
    reason: 'failed',
    errorCode: apiError.code,
    errorMessage: message,
    attempts: job.attempts,
  });
  deps.store.failJob(job.id, message);
  audit(deps, run, 'run.failed', { code: apiError.code, message });
}

async function publish(
  deps: WorkerDeps,
  job: JobDto,
  run: RunDto,
  repo: RepositoryDto,
  body: string,
  now: Date,
  reason: string
): Promise<void> {
  const installationId = deps.store.getGitHubInstallationId(repo.id);
  if (!installationId) {
    failRun(deps, run, 'installation_missing', '找不到仓库对应的 GitHub installation');
    deps.store.failJob(job.id, 'installation_missing');
    return;
  }
  const target = run.prNumber ?? run.issueNumber;
  if (!target) {
    failRun(deps, run, 'missing_target', '缺少 Issue/PR 编号，拒绝发布');
    deps.store.failJob(job.id, 'missing_target');
    return;
  }
  try {
    const comment = await deps.github.createComment(installationId, repoRef(repo), target, body);
    deps.store.updateRun(run.id, {
      status: 'posted',
      postedCommentId: comment.id,
      reason,
      errorCode: null,
      errorMessage: null,
      attempts: job.attempts,
    });
    deps.store.markJobDone(job.id);
    audit(deps, run, 'run.posted', { commentId: comment.id, htmlUrl: comment.htmlUrl, reason });
  } catch (error) {
    scheduleRetryOrFail(deps, job, run, error, now, 'publish');
  }
}

async function lookupPermission(deps: WorkerDeps, installationId: number, repo: RepositoryDto, login: string) {
  try {
    return await deps.github.getPermission(installationId, repoRef(repo), login);
  } catch (error) {
    deps.logger?.warn(
      { repo: `${repo.owner}/${repo.name}`, login, err: toGitHubApiError(error).message },
      'permission_lookup_failed'
    );
    return 'unknown' as const;
  }
}

async function processRun(
  deps: WorkerDeps,
  job: JobDto,
  run: RunDto,
  repo: RepositoryDto,
  settings: RepoSettingsDto,
  global: GlobalSettingsDto,
  now: Date
): Promise<void> {
  const installationId = deps.store.getGitHubInstallationId(repo.id);
  if (!installationId) {
    failRun(deps, run, 'installation_missing', '找不到仓库对应的 GitHub installation，无法读取上下文');
    deps.store.failJob(job.id, 'installation_missing');
    return;
  }

  const permission = await lookupPermission(deps, installationId, repo, run.actorLogin);
  const recent = deps.store.countTriggeredRunsForRepoSince(repo.id, hoursAgo(now, 1).toISOString());
  const decision = evaluatePolicy({
    global,
    repoEnabled: repo.repoEnabled,
    settings,
    trigger: run.triggerKind,
    labels: run.labels,
    actorLogin: run.actorLogin,
    actorIsBot: run.actorIsBot,
    actorPermission: permission,
    recentRepliesInLastHour: recent,
    appSlug: deps.config.github.appSlug,
    now,
  });

  if (decision.action === 'skip') {
    skipRun(deps, run, decision.reason);
    audit(deps, run, 'policy.skip', { reason: decision.reason });
    return;
  }

  let context;
  try {
    context = await buildContext({
      github: deps.github,
      installationId,
      repo: repoRef(repo),
      kind: run.prNumber ? 'pull_request' : 'issue',
      number: run.prNumber ?? run.issueNumber ?? 0,
      trigger: run.triggerKind,
      action: run.action,
      language: global.defaultReplyLanguage,
      maxComments: settings.maxContextComments,
      maxFiles: settings.maxChangedFiles,
      mention: run.triggerKind === 'mention',
    });
  } catch (error) {
    scheduleRetryOrFail(deps, job, run, error, now, 'context_read');
    return;
  }

  const templateBody = settings.templateId
    ? (deps.store.getTemplate(settings.templateId)?.body ?? undefined)
    : undefined;
  let generator: ReplyGenerator;
  try {
    generator = makeGenerator(deps, global.generatorProvider, templateBody);
  } catch (error) {
    const code = error instanceof GeneratorConfigError ? error.code : 'generator_config_error';
    const message = error instanceof Error ? error.message : String(error);
    failRun(deps, run, code, message);
    deps.store.failJob(job.id, message);
    return;
  }

  let generated;
  try {
    generated = await generator.generate({
      ...context.generationInput,
      maxReplyChars: settings.maxReplyChars,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failRun(deps, run, 'generation_failed', message);
    deps.store.failJob(job.id, message);
    return;
  }

  const safety = sanitizeReply(generated.body, { maxChars: settings.maxReplyChars });
  if (!safety.ok) {
    deps.store.updateRun(run.id, {
      status: safety.code === 'blocked_sensitive' ? 'blocked_sensitive' : 'failed',
      reason: safety.code,
      contextSummary: context.summary,
      attempts: job.attempts,
      errorCode: safety.code,
      // Never persist the offending text: it may contain a real secret.
      errorMessage: safety.reason,
    });
    deps.store.markJobDone(job.id);
    audit(deps, run, safety.code === 'blocked_sensitive' ? 'run.blocked_sensitive' : 'run.failed', {
      code: safety.code,
      reason: safety.reason,
    });
    return;
  }

  if (decision.action === 'draft') {
    deps.store.updateRun(run.id, {
      status: 'drafted',
      reason: decision.reason,
      contextSummary: context.summary,
      generatedReply: safety.body,
      fallbackUsed: generated.fallbackUsed,
      attempts: job.attempts,
    });
    deps.store.markJobDone(job.id);
    audit(deps, run, 'run.drafted', {
      reason: decision.reason,
      templateName: generated.templateName,
      fallbackUsed: generated.fallbackUsed,
    });
    return;
  }

  const publishCheck = canPublishNow({
    global,
    repoEnabled: repo.repoEnabled,
    settings,
    trigger: run.triggerKind,
  });
  if (!publishCheck.ok) {
    deps.store.updateRun(run.id, {
      status: 'drafted',
      reason: publishCheck.reason,
      contextSummary: context.summary,
      generatedReply: safety.body,
      fallbackUsed: generated.fallbackUsed,
      attempts: job.attempts,
    });
    deps.store.markJobDone(job.id);
    audit(deps, run, 'run.drafted', { reason: publishCheck.reason });
    return;
  }
  if (!settings.autoPostEnabled || settings.requireApproval) {
    deps.store.updateRun(run.id, {
      status: 'drafted',
      reason: settings.requireApproval ? 'approval_required' : 'auto_post_disabled',
      contextSummary: context.summary,
      generatedReply: safety.body,
      fallbackUsed: generated.fallbackUsed,
      attempts: job.attempts,
    });
    deps.store.markJobDone(job.id);
    audit(deps, run, 'run.drafted', { reason: 'settings_changed' });
    return;
  }

  deps.store.updateRun(run.id, {
    status: 'posting',
    contextSummary: context.summary,
    generatedReply: safety.body,
    fallbackUsed: generated.fallbackUsed,
    attempts: job.attempts,
  });
  await publish(deps, job, run, repo, safety.body, now, 'auto_posted');
}

async function publishApprovedRun(
  deps: WorkerDeps,
  job: JobDto,
  run: RunDto,
  repo: RepositoryDto,
  settings: RepoSettingsDto,
  global: GlobalSettingsDto,
  now: Date
): Promise<void> {
  const body = run.editedReply ?? run.generatedReply;
  if (!body || !body.trim()) {
    failRun(deps, run, 'no_reply_content', '没有可发布的回复内容');
    deps.store.failJob(job.id, 'no_reply_content');
    return;
  }
  const safety = sanitizeReply(body, { maxChars: settings.maxReplyChars });
  if (!safety.ok) {
    deps.store.updateRun(run.id, {
      status: safety.code === 'blocked_sensitive' ? 'blocked_sensitive' : 'failed',
      reason: safety.code,
      errorCode: safety.code,
      errorMessage: safety.reason,
    });
    deps.store.markJobDone(job.id);
    audit(deps, run, 'run.blocked_sensitive', { reason: safety.reason });
    return;
  }
  const check = canPublishNow({
    global,
    repoEnabled: repo.repoEnabled,
    settings,
    trigger: run.triggerKind,
  });
  if (!check.ok) {
    deps.store.updateRun(run.id, {
      status: 'drafted',
      reason: check.reason,
      generatedReply: safety.body,
    });
    deps.store.markJobDone(job.id);
    audit(deps, run, 'run.drafted', { reason: check.reason });
    return;
  }
  deps.store.updateRun(run.id, { status: 'posting' });
  await publish(deps, job, run, repo, safety.body, now, 'approved_and_posted');
}

async function handleJob(deps: WorkerDeps, job: JobDto): Promise<void> {
  const run = deps.store.getRunById(job.runId);
  if (!run) {
    deps.store.failJob(job.id, 'run_not_found');
    return;
  }
  const repo = deps.store.getRepositoryById(run.repoId);
  if (!repo) {
    failRun(deps, run, 'repo_missing', '运行对应的仓库已不存在');
    deps.store.failJob(job.id, 'repo_missing');
    return;
  }
  const settings = deps.store.getRepoSettings(repo.id);
  const global = deps.store.getGlobalSettings();
  const now = deps.now ? deps.now() : new Date();

  const gateResult = gate(deps, job, run, repo, settings, global);
  if (!gateResult.ok) {
    skipRun(deps, run, gateResult.reason);
    deps.store.markJobDone(job.id);
    deps.logger?.info({ runId: run.id, reason: gateResult.reason }, 'job_skipped');
    return;
  }

  if (job.type === 'publish') {
    await publishApprovedRun(deps, job, run, repo, settings, global, now);
    return;
  }
  await processRun(deps, job, run, repo, settings, global, now);
}

/**
 * Claims and executes one job. Returns the job when work was attempted, or
 * null when the queue is empty (or the claim lost a race).
 */
export async function processNextJob(deps: WorkerDeps): Promise<JobDto | null> {
  const now = deps.now ? deps.now() : new Date();
  const job = deps.store.claimNextJob(now.toISOString());
  if (!job) return null;
  try {
    await handleJob(deps, job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const run = deps.store.getRunById(job.runId);
    if (run) failRun(deps, run, 'worker_error', message);
    deps.store.failJob(job.id, message);
    deps.logger?.error({ jobId: job.id, err: message }, 'worker_error');
  }
  return job;
}

export function startWorker(deps: WorkerDeps, intervalMs = 1000): { stop: () => void } {
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      for (let i = 0; i < 10; i += 1) {
        const job = await processNextJob(deps);
        if (!job) break;
      }
    } catch (error) {
      deps.logger?.error(
        { err: error instanceof Error ? error.message : String(error) },
        'worker_tick_failed'
      );
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
