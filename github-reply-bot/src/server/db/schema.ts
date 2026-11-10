import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const installations = sqliteTable('installations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  githubInstallationId: integer('github_installation_id').notNull().unique(),
  accountLogin: text('account_login').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const repositories = sqliteTable('repositories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  installationId: integer('installation_id')
    .notNull()
    .references(() => installations.id, { onDelete: 'cascade' }),
  githubRepoId: integer('github_repo_id').notNull().unique(),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  repoEnabled: integer('repo_enabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const repoSettings = sqliteTable('repo_settings', {
  repoId: integer('repo_id')
    .primaryKey()
    .references(() => repositories.id, { onDelete: 'cascade' }),
  onIssueOpened: integer('on_issue_opened', { mode: 'boolean' }).notNull().default(false),
  onIssueLabeled: integer('on_issue_labeled', { mode: 'boolean' }).notNull().default(false),
  onPrOpened: integer('on_pr_opened', { mode: 'boolean' }).notNull().default(false),
  onPrLabeled: integer('on_pr_labeled', { mode: 'boolean' }).notNull().default(false),
  onMention: integer('on_mention', { mode: 'boolean' }).notNull().default(false),
  autoPostEnabled: integer('auto_post_enabled', { mode: 'boolean' }).notNull().default(false),
  requireApproval: integer('require_approval', { mode: 'boolean' }).notNull().default(true),
  triggerLabels: text('trigger_labels').notNull().default('[]'),
  mentionTriggerEnabled: integer('mention_trigger_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  allowedTriggerRoles: text('allowed_trigger_roles').notNull().default('maintainer'),
  rateLimitPerHour: integer('rate_limit_per_hour').notNull().default(10),
  quietHoursEnabled: integer('quiet_hours_enabled', { mode: 'boolean' }).notNull().default(false),
  quietHoursStart: text('quiet_hours_start').notNull().default('22:00'),
  quietHoursEnd: text('quiet_hours_end').notNull().default('08:00'),
  quietHoursTimezone: text('quiet_hours_timezone').notNull().default('UTC'),
  maxReplyChars: integer('max_reply_chars').notNull().default(2000),
  maxContextComments: integer('max_context_comments').notNull().default(10),
  maxChangedFiles: integer('max_changed_files').notNull().default(20),
  templateId: integer('template_id'),
  storeEventPayload: integer('store_event_payload', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
});

export const globalSettings = sqliteTable('global_settings', {
  id: integer('id').primaryKey(),
  automationEnabled: integer('automation_enabled', { mode: 'boolean' }).notNull().default(false),
  dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(true),
  generatorProvider: text('generator_provider').notNull().default('template'),
  retentionDays: integer('retention_days').notNull().default(30),
  defaultReplyLanguage: text('default_reply_language').notNull().default('auto'),
  updatedAt: text('updated_at').notNull(),
});

export const replyTemplates = sqliteTable('reply_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoId: integer('repo_id'),
  name: text('name').notNull(),
  body: text('body').notNull(),
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const runs = sqliteTable(
  'runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deliveryId: text('delivery_id').notNull().unique(),
    dedupeKey: text('dedupe_key').unique(),
    eventType: text('event_type').notNull(),
    action: text('action').notNull(),
    triggerKind: text('trigger_kind').notNull().default('other'),
    labels: text('labels').notNull().default('[]'),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    issueNumber: integer('issue_number'),
    prNumber: integer('pr_number'),
    actorLogin: text('actor_login').notNull(),
    actorIsBot: integer('actor_is_bot', { mode: 'boolean' }).notNull().default(false),
    status: text('status').notNull(),
    reason: text('reason'),
    contextSummary: text('context_summary'),
    eventPayload: text('event_payload'),
    generatedReply: text('generated_reply'),
    editedReply: text('edited_reply'),
    postedCommentId: integer('posted_comment_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    attempts: integer('attempts').notNull().default(0),
    fallbackUsed: integer('fallback_used', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_runs_repo_created').on(table.repoId, table.createdAt), index('idx_runs_status').on(table.status)]
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id'),
    repoId: integer('repo_id'),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    detail: text('detail'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_audit_created').on(table.createdAt)]
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    status: text('status').notNull().default('pending'),
    availableAt: text('available_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_jobs_status_available').on(table.status, table.availableAt)]
);

export type InstallationRow = typeof installations.$inferSelect;
export type RepositoryRow = typeof repositories.$inferSelect;
export type RepoSettingsRow = typeof repoSettings.$inferSelect;
export type GlobalSettingsRow = typeof globalSettings.$inferSelect;
export type ReplyTemplateRow = typeof replyTemplates.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
