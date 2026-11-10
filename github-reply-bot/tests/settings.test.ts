import { describe, expect, it } from 'vitest';
import {
  approveRunSchema,
  globalSettingsUpdateSchema,
  isValidTimeZone,
  listRunsQuerySchema,
  repoSettingsUpdateSchema,
  validateMutualExclusion,
} from '../src/shared/validation';

describe('settings validation', () => {
  it('rejects out-of-range repository values', () => {
    expect(repoSettingsUpdateSchema.safeParse({ rateLimitPerHour: 0 }).success).toBe(false);
    expect(repoSettingsUpdateSchema.safeParse({ rateLimitPerHour: 101 }).success).toBe(false);
    expect(repoSettingsUpdateSchema.safeParse({ maxReplyChars: 199 }).success).toBe(false);
    expect(repoSettingsUpdateSchema.safeParse({ maxReplyChars: 8001 }).success).toBe(false);
    expect(repoSettingsUpdateSchema.safeParse({ maxContextComments: 51 }).success).toBe(false);
    expect(repoSettingsUpdateSchema.safeParse({ maxChangedFiles: 101 }).success).toBe(false);
    expect(repoSettingsUpdateSchema.safeParse({ quietHoursStart: '25:00' }).success).toBe(false);
    expect(repoSettingsUpdateSchema.safeParse({ quietHoursStart: '08:00' }).success).toBe(true);
  });

  it('rejects unknown keys and oversized trigger label lists', () => {
    expect(repoSettingsUpdateSchema.safeParse({ unknownKey: true }).success).toBe(false);
    expect(
      repoSettingsUpdateSchema.safeParse({ triggerLabels: Array.from({ length: 21 }, (_, i) => `label-${i}`) }).success
    ).toBe(false);
    expect(repoSettingsUpdateSchema.safeParse({ triggerLabels: ['bot-reply'] }).success).toBe(true);
  });

  it('enforces auto_post / require_approval mutual exclusion', () => {
    expect(validateMutualExclusion({ autoPostEnabled: true, requireApproval: true })).not.toBeNull();
    expect(validateMutualExclusion({ autoPostEnabled: true, requireApproval: false })).toBeNull();
    expect(validateMutualExclusion({ autoPostEnabled: false, requireApproval: true })).toBeNull();
  });

  it('validates global settings and time zones', () => {
    expect(globalSettingsUpdateSchema.safeParse({ retentionDays: 0 }).success).toBe(false);
    expect(globalSettingsUpdateSchema.safeParse({ retentionDays: 366 }).success).toBe(false);
    expect(globalSettingsUpdateSchema.safeParse({ generatorProvider: 'cloud' }).success).toBe(false);
    expect(globalSettingsUpdateSchema.safeParse({ generatorProvider: 'http_llm', dryRun: true }).success).toBe(true);
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('validates approval payloads and pagination', () => {
    expect(approveRunSchema.safeParse({}).success).toBe(true);
    expect(approveRunSchema.safeParse({ reply: '   ' }).success).toBe(false);
    expect(approveRunSchema.safeParse({ reply: 'hello' }).success).toBe(true);
    expect(listRunsQuerySchema.safeParse({}).success).toBe(true);
    expect(listRunsQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(listRunsQuerySchema.safeParse({ status: 'posted' }).success).toBe(true);
    expect(listRunsQuerySchema.safeParse({ status: 'nope' }).success).toBe(false);
    expect(listRunsQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false);
  });
});
