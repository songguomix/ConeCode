export const RUN_STATUSES = [
  'received',
  'ignored',
  'skipped',
  'drafted',
  'approved',
  'rejected',
  'posting',
  'posted',
  'retrying',
  'failed',
  'blocked_sensitive',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TRIGGER_KINDS = [
  'issue_opened',
  'issue_labeled',
  'pr_opened',
  'pr_labeled',
  'mention',
  'other',
] as const;

export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export type ReplyLanguage = 'auto' | 'zh-CN' | 'en';
export type GeneratorProvider = 'template' | 'http_llm';
export type AllowedTriggerRoles = 'maintainer' | 'anyone';
export type PermissionLevel = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none' | 'unknown';

export interface GlobalSettingsDto {
  automationEnabled: boolean;
  dryRun: boolean;
  generatorProvider: GeneratorProvider;
  retentionDays: number;
  defaultReplyLanguage: ReplyLanguage;
  updatedAt: string;
}

export interface RepoSettingsDto {
  onIssueOpened: boolean;
  onIssueLabeled: boolean;
  onPrOpened: boolean;
  onPrLabeled: boolean;
  onMention: boolean;
  autoPostEnabled: boolean;
  requireApproval: boolean;
  triggerLabels: string[];
  mentionTriggerEnabled: boolean;
  allowedTriggerRoles: AllowedTriggerRoles;
  rateLimitPerHour: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursTimezone: string;
  maxReplyChars: number;
  maxContextComments: number;
  maxChangedFiles: number;
  templateId: number | null;
  storeEventPayload: boolean;
  updatedAt: string;
}

export interface RepositoryDto {
  id: number;
  installationId: number;
  githubRepoId: number;
  owner: string;
  name: string;
  repoEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  settings: RepoSettingsDto;
}

export interface RunDto {
  id: number;
  deliveryId: string;
  dedupeKey: string | null;
  eventType: string;
  action: string;
  triggerKind: TriggerKind;
  labels: string[];
  repoId: number;
  repository: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  actorLogin: string;
  actorIsBot: boolean;
  status: RunStatus;
  reason: string | null;
  contextSummary: unknown;
  eventPayload: unknown;
  generatedReply: string | null;
  editedReply: string | null;
  postedCommentId: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  fallbackUsed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogDto {
  id: number;
  runId: number | null;
  repoId: number | null;
  actor: string;
  action: string;
  detail: unknown;
  createdAt: string;
}

export interface JobDto {
  id: number;
  runId: number;
  type: string;
  status: string;
  availableAt: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export interface WebhookHealthDto {
  lastReceivedAt: string | null;
  lastEvent: string | null;
  lastDeliveryId: string | null;
  lastRejectedAt: string | null;
}

export interface OverviewDto {
  status: {
    automationEnabled: boolean;
    dryRun: boolean;
    generatorProvider: GeneratorProvider;
    githubConfigured: boolean;
    webhookConfigured: boolean;
    adminConfigured: boolean;
    missingConfig: string[];
  };
  counts: {
    runsToday: number;
    postedToday: number;
    failedToday: number;
    draftsPending: number;
    repositories: number;
  };
  webhook: WebhookHealthDto;
}

export interface ReplyTemplateDto {
  id: number;
  repoId: number | null;
  name: string;
  body: string;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RepoListDto {
  items: RepositoryDto[];
}

export interface RunListDto {
  items: RunDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}
