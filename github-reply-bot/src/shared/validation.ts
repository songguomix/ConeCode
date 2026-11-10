import { z } from 'zod';
import { RUN_STATUSES } from './types';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export const loginSchema = z.object({
  token: z.string().min(1).max(4096),
});

export const globalSettingsUpdateSchema = z
  .object({
    automationEnabled: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    generatorProvider: z.enum(['template', 'http_llm']).optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
    defaultReplyLanguage: z.enum(['auto', 'zh-CN', 'en']).optional(),
  })
  .strict();

export const repoSettingsUpdateSchema = z
  .object({
    onIssueOpened: z.boolean().optional(),
    onIssueLabeled: z.boolean().optional(),
    onPrOpened: z.boolean().optional(),
    onPrLabeled: z.boolean().optional(),
    onMention: z.boolean().optional(),
    autoPostEnabled: z.boolean().optional(),
    requireApproval: z.boolean().optional(),
    triggerLabels: z
      .array(z.string().trim().min(1).max(50))
      .max(20)
      .optional(),
    mentionTriggerEnabled: z.boolean().optional(),
    allowedTriggerRoles: z.enum(['maintainer', 'anyone']).optional(),
    rateLimitPerHour: z.number().int().min(1).max(100).optional(),
    quietHoursEnabled: z.boolean().optional(),
    quietHoursStart: z.string().regex(HHMM, 'quietHoursStart must be HH:mm').optional(),
    quietHoursEnd: z.string().regex(HHMM, 'quietHoursEnd must be HH:mm').optional(),
    quietHoursTimezone: z.string().optional(),
    maxReplyChars: z.number().int().min(200).max(8000).optional(),
    maxContextComments: z.number().int().min(0).max(50).optional(),
    maxChangedFiles: z.number().int().min(0).max(100).optional(),
    templateId: z.number().int().positive().nullable().optional(),
    storeEventPayload: z.boolean().optional(),
  })
  .strict();

export const repoEnabledUpdateSchema = z.object({
  repoEnabled: z.boolean(),
});

export const approveRunSchema = z
  .object({
    reply: z.string().trim().min(1).max(20000).optional(),
  })
  .strict();

export const rejectRunSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const listRunsQuerySchema = z.object({
  status: z.enum(RUN_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const templateCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  body: z.string().trim().min(1).max(20000),
  repoId: z.number().int().positive().nullable().optional(),
});

export const templateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  body: z.string().trim().min(1).max(20000).optional(),
});

export interface SettingsLike {
  autoPostEnabled: boolean;
  requireApproval: boolean;
}

/** `auto_post` and `require_approval` must never both be active. */
export function validateMutualExclusion(settings: SettingsLike): string | null {
  if (settings.autoPostEnabled && settings.requireApproval) {
    return 'auto_post_enabled 与 require_approval 互斥：开启自动发布时必须关闭人工审核';
  }
  return null;
}

export const APPROVABLE_STATUSES = ['drafted', 'rejected', 'failed'] as const;
export const REJECTABLE_STATUSES = ['drafted', 'approved', 'failed', 'blocked_sensitive'] as const;
export const RETRYABLE_STATUSES = ['failed', 'retrying'] as const;
