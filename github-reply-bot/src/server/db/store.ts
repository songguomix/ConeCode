import { and, asc, count, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import type { DatabaseHandle } from './index';
import {
  auditLogs,
  globalSettings,
  installations,
  jobs,
  replyTemplates,
  repoSettings,
  repositories,
  runs,
  type AuditLogRow,
  type GlobalSettingsRow,
  type JobRow,
  type ReplyTemplateRow,
  type RepositoryRow,
  type RepoSettingsRow,
  type RunRow,
} from './schema';
import type {
  AuditLogDto,
  GeneratorProvider,
  GlobalSettingsDto,
  JobDto,
  ReplyLanguage,
  ReplyTemplateDto,
  RepoListDto,
  RepoSettingsDto,
  RepositoryDto,
  RunDto,
  RunListDto,
  RunStatus,
  TriggerKind,
  WebhookHealthDto,
} from '../../shared/types';
import { BUILTIN_TEMPLATES } from '../generator/builtinTemplates';

const DEFAULT_REPO_SETTINGS: Omit<RepoSettingsDto, 'updatedAt'> = {
  onIssueOpened: false,
  onIssueLabeled: false,
  onPrOpened: false,
  onPrLabeled: false,
  onMention: false,
  autoPostEnabled: false,
  requireApproval: true,
  triggerLabels: [],
  mentionTriggerEnabled: false,
  allowedTriggerRoles: 'maintainer',
  rateLimitPerHour: 10,
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '08:00',
  quietHoursTimezone: 'UTC',
  maxReplyChars: 2000,
  maxContextComments: 10,
  maxChangedFiles: 20,
  templateId: null,
  storeEventPayload: false,
};

export const DEFAULT_GLOBAL_SETTINGS: Omit<GlobalSettingsDto, 'updatedAt'> = {
  automationEnabled: false,
  dryRun: true,
  generatorProvider: 'template',
  retentionDays: 30,
  defaultReplyLanguage: 'auto',
};

export interface CreateRunInput {
  deliveryId: string;
  dedupeKey: string;
  eventType: string;
  action: string;
  triggerKind: TriggerKind;
  labels: string[];
  repoId: number;
  issueNumber: number | null;
  prNumber: number | null;
  actorLogin: string;
  actorIsBot: boolean;
  status: RunStatus;
  reason: string | null;
  eventPayload?: unknown;
}

export interface RunPatch {
  status?: RunStatus;
  reason?: string | null;
  contextSummary?: unknown;
  generatedReply?: string | null;
  editedReply?: string | null;
  postedCommentId?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  attempts?: number;
  fallbackUsed?: boolean;
}

export interface AuditInput {
  runId?: number | null;
  repoId?: number | null;
  actor: string;
  action: string;
  detail?: unknown;
}

const TRIGGERED_STATUSES: RunStatus[] = [
  'drafted',
  'approved',
  'posting',
  'posted',
  'retrying',
];

export function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toGlobalSettingsDto(row: GlobalSettingsRow): GlobalSettingsDto {
  return {
    automationEnabled: row.automationEnabled,
    dryRun: row.dryRun,
    generatorProvider: row.generatorProvider as GeneratorProvider,
    retentionDays: row.retentionDays,
    defaultReplyLanguage: row.defaultReplyLanguage as ReplyLanguage,
    updatedAt: row.updatedAt,
  };
}

export function toRepoSettingsDto(row: RepoSettingsRow): RepoSettingsDto {
  return {
    onIssueOpened: row.onIssueOpened,
    onIssueLabeled: row.onIssueLabeled,
    onPrOpened: row.onPrOpened,
    onPrLabeled: row.onPrLabeled,
    onMention: row.onMention,
    autoPostEnabled: row.autoPostEnabled,
    requireApproval: row.requireApproval,
    triggerLabels: parseJson<string[]>(row.triggerLabels, []),
    mentionTriggerEnabled: row.mentionTriggerEnabled,
    allowedTriggerRoles: row.allowedTriggerRoles === 'anyone' ? 'anyone' : 'maintainer',
    rateLimitPerHour: row.rateLimitPerHour,
    quietHoursEnabled: row.quietHoursEnabled,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    quietHoursTimezone: row.quietHoursTimezone,
    maxReplyChars: row.maxReplyChars,
    maxContextComments: row.maxContextComments,
    maxChangedFiles: row.maxChangedFiles,
    templateId: row.templateId,
    storeEventPayload: row.storeEventPayload,
    updatedAt: row.updatedAt,
  };
}

export function toRunDto(row: RunRow, repository: string | null): RunDto {
  return {
    id: row.id,
    deliveryId: row.deliveryId,
    dedupeKey: row.dedupeKey,
    eventType: row.eventType,
    action: row.action,
    triggerKind: (row.triggerKind as TriggerKind) ?? 'other',
    labels: parseJson<string[]>(row.labels, []),
    repoId: row.repoId,
    repository,
    issueNumber: row.issueNumber,
    prNumber: row.prNumber,
    actorLogin: row.actorLogin,
    actorIsBot: row.actorIsBot,
    status: row.status as RunStatus,
    reason: row.reason,
    contextSummary: parseJson<unknown>(row.contextSummary, null),
    eventPayload: parseJson<unknown>(row.eventPayload, null),
    generatedReply: row.generatedReply,
    editedReply: row.editedReply,
    postedCommentId: row.postedCommentId,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    attempts: row.attempts,
    fallbackUsed: row.fallbackUsed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toJobDto(row: JobRow): JobDto {
  return {
    id: row.id,
    runId: row.runId,
    type: row.type,
    status: row.status,
    availableAt: row.availableAt,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

function toAuditDto(row: AuditLogRow): AuditLogDto {
  return {
    id: row.id,
    runId: row.runId,
    repoId: row.repoId,
    actor: row.actor,
    action: row.action,
    detail: parseJson<unknown>(row.detail, null),
    createdAt: row.createdAt,
  };
}

function toTemplateDto(row: ReplyTemplateRow): ReplyTemplateDto {
  return {
    id: row.id,
    repoId: row.repoId,
    name: row.name,
    body: row.body,
    isBuiltin: row.isBuiltin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function repoLabel(row: { owner: string; name: string }): string {
  return `${row.owner}/${row.name}`;
}

export class Store {
  constructor(private readonly handle: DatabaseHandle) {}

  private get db() {
    return this.handle.db;
  }

  // ---------------------------------------------------------------- settings
  getGlobalSettings(): GlobalSettingsDto {
    const row = this.db.select().from(globalSettings).where(eq(globalSettings.id, 1)).get();
    if (row) return toGlobalSettingsDto(row);
    const now = nowIso();
    const inserted = this.db
      .insert(globalSettings)
      .values({
        id: 1,
        automationEnabled: DEFAULT_GLOBAL_SETTINGS.automationEnabled,
        dryRun: DEFAULT_GLOBAL_SETTINGS.dryRun,
        generatorProvider: DEFAULT_GLOBAL_SETTINGS.generatorProvider,
        retentionDays: DEFAULT_GLOBAL_SETTINGS.retentionDays,
        defaultReplyLanguage: DEFAULT_GLOBAL_SETTINGS.defaultReplyLanguage,
        updatedAt: now,
      })
      .returning()
      .get();
    return toGlobalSettingsDto(inserted);
  }

  updateGlobalSettings(patch: Partial<Omit<GlobalSettingsDto, 'updatedAt'>>): GlobalSettingsDto {
    this.getGlobalSettings();
    const row = this.db
      .update(globalSettings)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(globalSettings.id, 1))
      .returning()
      .get();
    return toGlobalSettingsDto(row);
  }

  // ------------------------------------------------------ installations/repos
  upsertInstallation(githubInstallationId: number, accountLogin: string) {
    const now = nowIso();
    return this.db
      .insert(installations)
      .values({
        githubInstallationId,
        accountLogin,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: installations.githubInstallationId,
        set: { accountLogin, updatedAt: now },
      })
      .returning()
      .get();
  }

  deleteInstallation(githubInstallationId: number): boolean {
    const result = this.db
      .delete(installations)
      .where(eq(installations.githubInstallationId, githubInstallationId))
      .run();
    return result.changes > 0;
  }

  listInstallations() {
    return this.db.select().from(installations).all();
  }

  upsertRepository(
    installationId: number,
    githubRepoId: number,
    owner: string,
    name: string
  ): RepositoryDto {
    const now = nowIso();
    const row = this.db
      .insert(repositories)
      .values({ installationId, githubRepoId, owner, name, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: repositories.githubRepoId,
        set: { installationId, owner, name, updatedAt: now },
      })
      .returning()
      .get();
    this.ensureRepoSettings(row.id);
    return this.toRepositoryDto(row);
  }

  getRepositoryById(id: number): RepositoryDto | null {
    const row = this.db.select().from(repositories).where(eq(repositories.id, id)).get();
    return row ? this.toRepositoryDto(row) : null;
  }

  getRepositoryByGithubId(githubRepoId: number): RepositoryDto | null {
    const row = this.db
      .select()
      .from(repositories)
      .where(eq(repositories.githubRepoId, githubRepoId))
      .get();
    return row ? this.toRepositoryDto(row) : null;
  }

  listRepositories(): RepoListDto {
    const rows = this.db.select().from(repositories).orderBy(asc(repositories.owner), asc(repositories.name)).all();
    const settingsRows = this.db.select().from(repoSettings).all();
    const settingsById = new Map(settingsRows.map((s) => [s.repoId, s]));
    return {
      items: rows.map((row) => {
        const settings = settingsById.get(row.id);
        return {
          ...this.toRepositoryDto(row, settings ? toRepoSettingsDto(settings) : undefined),
        };
      }),
    };
  }

  setRepoEnabled(repoId: number, enabled: boolean): RepositoryDto | null {
    const row = this.db
      .update(repositories)
      .set({ repoEnabled: enabled, updatedAt: nowIso() })
      .where(eq(repositories.id, repoId))
      .returning()
      .get();
    return row ? this.toRepositoryDto(row) : null;
  }

  getRepoSettings(repoId: number): RepoSettingsDto {
    return this.ensureRepoSettings(repoId);
  }

  updateRepoSettings(repoId: number, patch: Partial<Omit<RepoSettingsDto, 'updatedAt'>>): RepoSettingsDto {
    this.ensureRepoSettings(repoId);
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      set[key] = key === 'triggerLabels' ? JSON.stringify(value) : value;
    }
    const row = this.db
      .update(repoSettings)
      .set(set as Partial<typeof repoSettings.$inferInsert>)
      .where(eq(repoSettings.repoId, repoId))
      .returning()
      .get();
    return toRepoSettingsDto(row);
  }

  private ensureRepoSettings(repoId: number): RepoSettingsDto {
    const existing = this.db.select().from(repoSettings).where(eq(repoSettings.repoId, repoId)).get();
    if (existing) return toRepoSettingsDto(existing);
    const inserted = this.db
      .insert(repoSettings)
      .values({
        repoId,
        triggerLabels: JSON.stringify(DEFAULT_REPO_SETTINGS.triggerLabels),
        allowedTriggerRoles: DEFAULT_REPO_SETTINGS.allowedTriggerRoles,
        quietHoursStart: DEFAULT_REPO_SETTINGS.quietHoursStart,
        quietHoursEnd: DEFAULT_REPO_SETTINGS.quietHoursEnd,
        quietHoursTimezone: DEFAULT_REPO_SETTINGS.quietHoursTimezone,
        rateLimitPerHour: DEFAULT_REPO_SETTINGS.rateLimitPerHour,
        maxReplyChars: DEFAULT_REPO_SETTINGS.maxReplyChars,
        maxContextComments: DEFAULT_REPO_SETTINGS.maxContextComments,
        maxChangedFiles: DEFAULT_REPO_SETTINGS.maxChangedFiles,
        updatedAt: nowIso(),
      })
      .returning()
      .get();
    return toRepoSettingsDto(inserted);
  }

  private toRepositoryDto(row: RepositoryRow, settings?: RepoSettingsDto): RepositoryDto {
    return {
      id: row.id,
      installationId: row.installationId,
      githubRepoId: row.githubRepoId,
      owner: row.owner,
      name: row.name,
      repoEnabled: row.repoEnabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      settings: settings ?? this.getRepoSettings(row.id),
    };
  }

  // ------------------------------------------------------------------- runs
  findRunByDeliveryOrDedupe(deliveryId: string, dedupeKey: string): RunRow | undefined {
    return this.db
      .select()
      .from(runs)
      .where(or(eq(runs.deliveryId, deliveryId), eq(runs.dedupeKey, dedupeKey)))
      .get();
  }

  createRun(
    input: CreateRunInput,
    options: { enqueue?: boolean; jobType?: string; availableAt?: string } = {}
  ): { created: boolean; run: RunDto } {
    const existing = this.findRunByDeliveryOrDedupe(input.deliveryId, input.dedupeKey);
    if (existing) {
      return { created: false, run: toRunDto(existing, this.repositoryLabel(existing.repoId)) };
    }
    const now = nowIso();
    const created = this.db.transaction((tx) => {
      const inserted = tx
        .insert(runs)
        .values({
          deliveryId: input.deliveryId,
          dedupeKey: input.dedupeKey,
          eventType: input.eventType,
          action: input.action,
          triggerKind: input.triggerKind,
          labels: JSON.stringify(input.labels),
          repoId: input.repoId,
          issueNumber: input.issueNumber,
          prNumber: input.prNumber,
          actorLogin: input.actorLogin,
          actorIsBot: input.actorIsBot,
          status: input.status,
          reason: input.reason,
          eventPayload:
            input.eventPayload === undefined ? null : JSON.stringify(input.eventPayload).slice(0, 64_000),
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      if (options.enqueue) {
        tx.insert(jobs)
          .values({
            runId: inserted.id,
            type: options.jobType ?? 'process',
            status: 'pending',
            availableAt: options.availableAt ?? now,
            attempts: 0,
            createdAt: now,
          })
          .run();
      }
      return inserted;
    });
    return { created: true, run: toRunDto(created, this.repositoryLabel(created.repoId)) };
  }

  getRunById(id: number): RunDto | null {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();
    return row ? toRunDto(row, this.repositoryLabel(row.repoId)) : null;
  }

  updateRun(id: number, patch: RunPatch): RunDto | null {
    const set: Partial<typeof runs.$inferInsert> = { updatedAt: nowIso() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.reason !== undefined) set.reason = patch.reason;
    if (patch.contextSummary !== undefined) set.contextSummary = JSON.stringify(patch.contextSummary);
    if (patch.generatedReply !== undefined) set.generatedReply = patch.generatedReply;
    if (patch.editedReply !== undefined) set.editedReply = patch.editedReply;
    if (patch.postedCommentId !== undefined) set.postedCommentId = patch.postedCommentId;
    if (patch.errorCode !== undefined) set.errorCode = patch.errorCode;
    if (patch.errorMessage !== undefined) set.errorMessage = patch.errorMessage;
    if (patch.attempts !== undefined) set.attempts = patch.attempts;
    if (patch.fallbackUsed !== undefined) set.fallbackUsed = patch.fallbackUsed;
    const row = this.db.update(runs).set(set).where(eq(runs.id, id)).returning().get();
    return row ? toRunDto(row, this.repositoryLabel(row.repoId)) : null;
  }

  listRuns(options: { status?: RunStatus; page: number; pageSize: number }): RunListDto {
    const where = options.status ? eq(runs.status, options.status) : undefined;
    const rows = this.db
      .select()
      .from(runs)
      .where(where)
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(options.pageSize)
      .offset((options.page - 1) * options.pageSize)
      .all();
    const totalRow = this.db.select({ value: count() }).from(runs).where(where).get();
    const labels = this.repositoryLabels(rows.map((row) => row.repoId));
    return {
      items: rows.map((row) => toRunDto(row, labels.get(row.repoId) ?? null)),
      total: totalRow?.value ?? 0,
      page: options.page,
      pageSize: options.pageSize,
    };
  }

  countRunsSince(iso: string, statuses?: RunStatus[]): number {
    const conditions = [gte(runs.createdAt, iso)];
    if (statuses && statuses.length > 0) conditions.push(inArray(runs.status, statuses));
    const row = this.db
      .select({ value: count() })
      .from(runs)
      .where(and(...conditions))
      .get();
    return row?.value ?? 0;
  }

  countRunsForRepoSince(repoId: number, iso: string, statuses: RunStatus[]): number {
    const row = this.db
      .select({ value: count() })
      .from(runs)
      .where(and(eq(runs.repoId, repoId), gte(runs.createdAt, iso), inArray(runs.status, statuses)))
      .get();
    return row?.value ?? 0;
  }

  countRunsByStatus(status: RunStatus): number {
    const row = this.db.select({ value: count() }).from(runs).where(eq(runs.status, status)).get();
    return row?.value ?? 0;
  }

  countRepositories(): number {
    const row = this.db.select({ value: count() }).from(repositories).get();
    return row?.value ?? 0;
  }

  /** Posted/drafted runs for a repo that represent a real reply attempt. */
  countTriggeredRunsForRepoSince(repoId: number, iso: string): number {
    return this.countRunsForRepoSince(repoId, iso, TRIGGERED_STATUSES);
  }

  hasPostedRunForDedupeKey(dedupeKey: string): boolean {
    const row = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.dedupeKey, dedupeKey), eq(runs.status, 'posted')))
      .get();
    return Boolean(row);
  }

  private repositoryLabel(repoId: number): string | null {
    const row = this.db.select().from(repositories).where(eq(repositories.id, repoId)).get();
    return row ? repoLabel(row) : null;
  }

  private repositoryLabels(repoIds: number[]): Map<number, string> {
    if (repoIds.length === 0) return new Map();
    const rows = this.db
      .select({ id: repositories.id, owner: repositories.owner, name: repositories.name })
      .from(repositories)
      .where(inArray(repositories.id, repoIds))
      .all();
    return new Map(rows.map((row) => [row.id, repoLabel(row)]));
  }

  getGitHubInstallationId(localRepositoryId: number): number | null {
    const row = this.db
      .select({ githubInstallationId: installations.githubInstallationId })
      .from(repositories)
      .innerJoin(installations, eq(repositories.installationId, installations.id))
      .where(eq(repositories.id, localRepositoryId))
      .get();
    return row?.githubInstallationId ?? null;
  }

  removeRepositoryByGithubId(githubRepoId: number): boolean {
    const result = this.db.delete(repositories).where(eq(repositories.githubRepoId, githubRepoId)).run();
    return result.changes > 0;
  }

  listAuditForRun(runId: number, limit = 50): AuditLogDto[] {
    return this.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.runId, runId))
      .orderBy(desc(auditLogs.id))
      .limit(Math.min(Math.max(limit, 1), 200))
      .all()
      .map(toAuditDto);
  }

  // ------------------------------------------------------------------- jobs
  enqueueJob(runId: number, type: string, availableAt = nowIso()): JobDto | null {
    const existing = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.runId, runId), inArray(jobs.status, ['pending', 'running'])))
      .get();
    if (existing) return null;
    const row = this.db
      .insert(jobs)
      .values({ runId, type, status: 'pending', availableAt, attempts: 0, createdAt: nowIso() })
      .returning()
      .get();
    return toJobDto(row);
  }

  claimNextJob(now: string): JobDto | null {
    const candidate = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), lte(jobs.availableAt, now)))
      .orderBy(asc(jobs.availableAt), asc(jobs.id))
      .get();
    if (!candidate) return null;
    const claimed = this.db
      .update(jobs)
      .set({ status: 'running', attempts: candidate.attempts + 1 })
      .where(and(eq(jobs.id, candidate.id), eq(jobs.status, 'pending')))
      .returning()
      .get();
    return claimed ? toJobDto(claimed) : null;
  }

  markJobDone(id: number): void {
    this.db.update(jobs).set({ status: 'done', lastError: null }).where(eq(jobs.id, id)).run();
  }

  failJob(id: number, error: string): void {
    this.db.update(jobs).set({ status: 'failed', lastError: error }).where(eq(jobs.id, id)).run();
  }

  rescheduleJob(id: number, availableAt: string, error: string): void {
    this.db
      .update(jobs)
      .set({ status: 'pending', availableAt, lastError: error })
      .where(eq(jobs.id, id))
      .run();
  }

  listJobsForRun(runId: number): JobDto[] {
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.runId, runId))
      .orderBy(asc(jobs.id))
      .all()
      .map(toJobDto);
  }

  // ------------------------------------------------------------------ audit
  addAudit(input: AuditInput): AuditLogDto {
    const row = this.db
      .insert(auditLogs)
      .values({
        runId: input.runId ?? null,
        repoId: input.repoId ?? null,
        actor: input.actor,
        action: input.action,
        detail: input.detail === undefined ? null : JSON.stringify(input.detail),
        createdAt: nowIso(),
      })
      .returning()
      .get();
    return toAuditDto(row);
  }

  listAudit(limit = 50): AuditLogDto[] {
    return this.db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.id))
      .limit(Math.min(Math.max(limit, 1), 200))
      .all()
      .map(toAuditDto);
  }

  latestAudit(action: string): AuditLogDto | null {
    const row = this.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, action))
      .orderBy(desc(auditLogs.id))
      .get();
    return row ? toAuditDto(row) : null;
  }

  getWebhookHealth(): WebhookHealthDto {
    const received = this.latestAudit('webhook.received');
    const rejected = this.latestAudit('webhook.rejected');
    const detail = (received?.detail ?? {}) as { event?: string; deliveryId?: string };
    return {
      lastReceivedAt: received?.createdAt ?? null,
      lastEvent: detail.event ?? null,
      lastDeliveryId: detail.deliveryId ?? null,
      lastRejectedAt: rejected?.createdAt ?? null,
    };
  }

  purgeOlderThan(cutoffIso: string): { runs: number; audits: number } {
    const terminal: RunStatus[] = [
      'posted',
      'rejected',
      'failed',
      'skipped',
      'ignored',
      'blocked_sensitive',
      'drafted',
      'approved',
    ];
    const deletedRuns = this.db
      .delete(runs)
      .where(and(lte(runs.createdAt, cutoffIso), inArray(runs.status, terminal)))
      .run();
    const deletedAudits = this.db.delete(auditLogs).where(lte(auditLogs.createdAt, cutoffIso)).run();
    return { runs: deletedRuns.changes, audits: deletedAudits.changes };
  }

  // --------------------------------------------------------------- templates
  listTemplates(repoId?: number | null): ReplyTemplateDto[] {
    const rows =
      repoId === undefined || repoId === null
        ? this.db.select().from(replyTemplates).orderBy(asc(replyTemplates.id)).all()
        : this.db
            .select()
            .from(replyTemplates)
            .where(or(eq(replyTemplates.repoId, repoId), sql`${replyTemplates.repoId} IS NULL`))
            .orderBy(asc(replyTemplates.id))
            .all();
    return rows.map(toTemplateDto);
  }

  getTemplate(id: number): ReplyTemplateDto | null {
    const row = this.db.select().from(replyTemplates).where(eq(replyTemplates.id, id)).get();
    return row ? toTemplateDto(row) : null;
  }

  createTemplate(input: { name: string; body: string; repoId?: number | null }): ReplyTemplateDto {
    const now = nowIso();
    const row = this.db
      .insert(replyTemplates)
      .values({
        name: input.name,
        body: input.body,
        repoId: input.repoId ?? null,
        isBuiltin: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return toTemplateDto(row);
  }

  updateTemplate(id: number, patch: { name?: string; body?: string }): ReplyTemplateDto | null {
    const row = this.db
      .update(replyTemplates)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(replyTemplates.id, id))
      .returning()
      .get();
    return row ? toTemplateDto(row) : null;
  }

  deleteTemplate(id: number): 'deleted' | 'builtin' | 'missing' {
    const row = this.db.select().from(replyTemplates).where(eq(replyTemplates.id, id)).get();
    if (!row) return 'missing';
    if (row.isBuiltin) return 'builtin';
    this.db.delete(replyTemplates).where(eq(replyTemplates.id, id)).run();
    return 'deleted';
  }

  seedBuiltinTemplates(): number {
    const now = nowIso();
    let inserted = 0;
    for (const definition of BUILTIN_TEMPLATES) {
      const existing = this.db
        .select()
        .from(replyTemplates)
        .where(and(eq(replyTemplates.name, definition.name), eq(replyTemplates.isBuiltin, true)))
        .get();
      if (existing) continue;
      this.db
        .insert(replyTemplates)
        .values({
          repoId: null,
          name: definition.name,
          body: definition.body.en,
          isBuiltin: true,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      inserted += 1;
    }
    return inserted;
  }
}

export { DEFAULT_REPO_SETTINGS };
