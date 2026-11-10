import { describe, expect, it } from 'vitest';
import { canPublishNow, evaluatePolicy, type PolicyInput } from '../src/server/policy/engine';
import { DEFAULT_REPO_SETTINGS } from '../src/server/db/store';
import type { GlobalSettingsDto, RepoSettingsDto } from '../src/shared/types';

const STAMP = '2025-01-01T00:00:00.000Z';

function settings(overrides: Partial<RepoSettingsDto> = {}): RepoSettingsDto {
  return { ...DEFAULT_REPO_SETTINGS, updatedAt: STAMP, ...overrides };
}

function globalSettings(overrides: Partial<GlobalSettingsDto> = {}): GlobalSettingsDto {
  return {
    automationEnabled: true,
    dryRun: false,
    generatorProvider: 'template',
    retentionDays: 30,
    defaultReplyLanguage: 'auto',
    updatedAt: STAMP,
    ...overrides,
  };
}

function baseInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    global: globalSettings(),
    repoEnabled: true,
    settings: settings({
      onIssueOpened: true,
      onIssueLabeled: true,
      onPrOpened: true,
      onPrLabeled: true,
      onMention: true,
      mentionTriggerEnabled: true,
    }),
    trigger: 'issue_opened',
    labels: ['bug'],
    actorLogin: 'alice',
    actorIsBot: false,
    actorPermission: 'read',
    recentRepliesInLastHour: 0,
    appSlug: 'reply-bot',
    now: new Date('2025-06-01T12:00:00Z'),
    ...overrides,
  };
}

describe('policy engine', () => {
  it('skips everything while automation is globally disabled', () => {
    expect(evaluatePolicy(baseInput({ global: globalSettings({ automationEnabled: false }) }))).toEqual({
      action: 'skip',
      reason: 'automation_disabled',
    });
  });

  it('skips when the repository is disabled', () => {
    expect(evaluatePolicy(baseInput({ repoEnabled: false }))).toEqual({
      action: 'skip',
      reason: 'repo_disabled',
    });
  });

  it('skips when the event switch is off', () => {
    expect(evaluatePolicy(baseInput({ settings: settings({ onIssueOpened: false }) }))).toEqual({
      action: 'skip',
      reason: 'event_disabled:issue_opened',
    });
  });

  it('skips unsupported actions', () => {
    expect(evaluatePolicy(baseInput({ trigger: 'other' }))).toEqual({
      action: 'skip',
      reason: 'unsupported_action',
    });
  });

  it('never replies to bots or to itself', () => {
    expect(evaluatePolicy(baseInput({ actorIsBot: true }))).toEqual({ action: 'skip', reason: 'bot_actor' });
    expect(evaluatePolicy(baseInput({ actorLogin: 'reply-bot[bot]', actorIsBot: false }))).toEqual({
      action: 'skip',
      reason: 'self_actor',
    });
  });

  it('requires both the mention switch and a configured slug', () => {
    expect(
      evaluatePolicy(baseInput({ trigger: 'mention', settings: settings({ onMention: true, mentionTriggerEnabled: false }) }))
    ).toEqual({ action: 'skip', reason: 'mention_trigger_disabled' });
    expect(evaluatePolicy(baseInput({ trigger: 'mention', appSlug: null }))).toEqual({
      action: 'skip',
      reason: 'mention_slug_not_configured',
    });
  });

  it('enforces trigger labels when configured', () => {
    expect(
      evaluatePolicy(baseInput({ settings: settings({ onIssueOpened: true, triggerLabels: ['bot-reply'] }) }))
    ).toEqual({ action: 'skip', reason: 'label_not_matched' });
    expect(
      evaluatePolicy(
        baseInput({
          settings: settings({ onIssueOpened: true, triggerLabels: ['bot-reply'] }),
          labels: ['bot-reply'],
        })
      ).action
    ).not.toBe('skip');
  });

  it('does not act on label events without configured trigger labels', () => {
    expect(evaluatePolicy(baseInput({ trigger: 'issue_labeled' }))).toEqual({
      action: 'skip',
      reason: 'no_trigger_labels_configured',
    });
  });

  it('enforces the per-repository hourly rate limit', () => {
    expect(
      evaluatePolicy(baseInput({ settings: settings({ onIssueOpened: true, rateLimitPerHour: 2 }), recentRepliesInLastHour: 2 }))
    ).toEqual({ action: 'skip', reason: 'rate_limited' });
  });

  it('skips inside quiet hours, including windows that wrap midnight', () => {
    const quiet = settings({
      onIssueOpened: true,
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      quietHoursTimezone: 'UTC',
    });
    expect(evaluatePolicy(baseInput({ settings: quiet, now: new Date('2025-06-01T23:30:00Z') }))).toEqual({
      action: 'skip',
      reason: 'quiet_hours',
    });
    expect(evaluatePolicy(baseInput({ settings: quiet, now: new Date('2025-06-01T02:00:00Z') }))).toEqual({
      action: 'skip',
      reason: 'quiet_hours',
    });
    expect(evaluatePolicy(baseInput({ settings: quiet, now: new Date('2025-06-01T12:00:00Z') })).action).not.toBe('skip');
  });

  it('always drafts in dry-run mode', () => {
    expect(evaluatePolicy(baseInput({ global: globalSettings({ dryRun: true }) }))).toEqual({
      action: 'draft',
      reason: 'dry_run',
    });
  });

  it('only lets maintainers auto-post, and only in maintainer role mode', () => {
    const auto = settings({
      onIssueOpened: true,
      autoPostEnabled: true,
      requireApproval: false,
    });
    expect(evaluatePolicy(baseInput({ settings: auto, actorPermission: 'read' }))).toEqual({
      action: 'draft',
      reason: 'role_limited_to_draft',
    });
    expect(
      evaluatePolicy(baseInput({ settings: { ...auto, allowedTriggerRoles: 'anyone' }, actorPermission: 'admin' }))
    ).toEqual({ action: 'draft', reason: 'anyone_role_restricted_to_draft' });
    expect(evaluatePolicy(baseInput({ settings: auto, actorPermission: 'write' }))).toEqual({
      action: 'draft',
      reason: 'role_limited_to_draft',
    });
    expect(evaluatePolicy(baseInput({ settings: auto, actorPermission: 'maintain' }))).toEqual({
      action: 'post',
      reason: 'auto_post',
    });
  });

  it('drafts when auto post is off or approval is required', () => {
    expect(
      evaluatePolicy(
        baseInput({
          settings: settings({ onIssueOpened: true, autoPostEnabled: false, requireApproval: false }),
          actorPermission: 'maintain',
        })
      )
    ).toEqual({ action: 'draft', reason: 'auto_post_disabled' });
    expect(
      evaluatePolicy(
        baseInput({
          settings: settings({ onIssueOpened: true, autoPostEnabled: true, requireApproval: true }),
          actorPermission: 'maintain',
        })
      )
    ).toEqual({ action: 'draft', reason: 'approval_required' });
  });

  it('re-checks publish gates', () => {
    const settingsOk = settings({ onIssueOpened: true });
    expect(
      canPublishNow({
        global: globalSettings(),
        repoEnabled: true,
        settings: settingsOk,
        trigger: 'issue_opened',
      })
    ).toEqual({ ok: true });
    expect(
      canPublishNow({
        global: globalSettings({ dryRun: true }),
        repoEnabled: true,
        settings: settingsOk,
        trigger: 'issue_opened',
      })
    ).toEqual({ ok: false, reason: 'dry_run_enabled' });
    expect(
      canPublishNow({
        global: globalSettings(),
        repoEnabled: true,
        settings: settingsOk,
        trigger: 'issue_opened',
      })
    ).toEqual({ ok: true });
    expect(
      canPublishNow({
        global: globalSettings({ automationEnabled: false }),
        repoEnabled: true,
        settings: settingsOk,
        trigger: 'issue_opened',
      })
    ).toEqual({ ok: false, reason: 'automation_disabled' });
    expect(
      canPublishNow({ global: globalSettings(), repoEnabled: false, settings: settingsOk, trigger: 'issue_opened' })
    ).toEqual({ ok: false, reason: 'repo_disabled' });
    expect(
      canPublishNow({
        global: globalSettings(),
        repoEnabled: true,
        settings: settings({ onIssueOpened: false }),
        trigger: 'issue_opened',
      })
    ).toEqual({ ok: false, reason: 'event_disabled:issue_opened' });
  });
});
