import type {
  GlobalSettingsDto,
  PermissionLevel,
  RepoSettingsDto,
  TriggerKind,
} from '../../shared/types';
import { isMaintainerPermission } from '../github/types';
import { isQuietHours } from '../util/time';

export type PolicyAction = 'post' | 'draft' | 'skip';

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
}

export interface PolicyInput {
  global: GlobalSettingsDto;
  repoEnabled: boolean;
  settings: RepoSettingsDto;
  trigger: TriggerKind;
  labels: string[];
  actorLogin: string;
  actorIsBot: boolean;
  actorPermission: PermissionLevel;
  recentRepliesInLastHour: number;
  appSlug: string | null;
  now: Date;
}

const SWITCH_BY_TRIGGER: Record<Exclude<TriggerKind, 'other'>, keyof RepoSettingsDto> = {
  issue_opened: 'onIssueOpened',
  issue_labeled: 'onIssueLabeled',
  pr_opened: 'onPrOpened',
  pr_labeled: 'onPrLabeled',
  mention: 'onMention',
};

function eventSwitchEnabled(settings: RepoSettingsDto, trigger: TriggerKind): boolean {
  if (trigger === 'other') return false;
  return settings[SWITCH_BY_TRIGGER[trigger]] === true;
}

/**
 * Pure decision function. Every branch returns an explicit reason so the
 * dashboard and audit log can explain why nothing was posted.
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { global, settings, trigger, labels, actorLogin, actorIsBot, actorPermission } = input;

  if (!global.automationEnabled) return { action: 'skip', reason: 'automation_disabled' };
  if (!input.repoEnabled) return { action: 'skip', reason: 'repo_disabled' };
  if (trigger === 'other') return { action: 'skip', reason: 'unsupported_action' };
  if (!eventSwitchEnabled(settings, trigger)) {
    return { action: 'skip', reason: `event_disabled:${trigger}` };
  }
  if (actorIsBot) return { action: 'skip', reason: 'bot_actor' };
  if (input.appSlug && actorLogin.toLowerCase() === `${input.appSlug}[bot]`.toLowerCase()) {
    return { action: 'skip', reason: 'self_actor' };
  }

  if (trigger === 'mention') {
    if (!settings.mentionTriggerEnabled) {
      return { action: 'skip', reason: 'mention_trigger_disabled' };
    }
    if (!input.appSlug) return { action: 'skip', reason: 'mention_slug_not_configured' };
  }

  const triggerLabels = settings.triggerLabels.map((label) => label.trim().toLowerCase()).filter(Boolean);
  if (triggerLabels.length > 0) {
    const repoLabels = labels.map((label) => label.toLowerCase());
    const matched = repoLabels.some((label) => triggerLabels.includes(label));
    if (!matched) return { action: 'skip', reason: 'label_not_matched' };
  } else if (trigger === 'issue_labeled' || trigger === 'pr_labeled') {
    return { action: 'skip', reason: 'no_trigger_labels_configured' };
  }

  if (input.recentRepliesInLastHour >= settings.rateLimitPerHour) {
    return { action: 'skip', reason: 'rate_limited' };
  }

  if (
    settings.quietHoursEnabled &&
    isQuietHours(input.now, settings.quietHoursStart, settings.quietHoursEnd, settings.quietHoursTimezone)
  ) {
    return { action: 'skip', reason: 'quiet_hours' };
  }

  if (global.dryRun) return { action: 'draft', reason: 'dry_run' };

  const maintainer = isMaintainerPermission(actorPermission);
  const anyoneAllowed = settings.allowedTriggerRoles === 'anyone';
  const mayAutoPost = maintainer && !anyoneAllowed;

  if (!mayAutoPost) {
    return {
      action: 'draft',
      reason: maintainer ? 'anyone_role_restricted_to_draft' : 'role_limited_to_draft',
    };
  }
  if (!settings.autoPostEnabled) return { action: 'draft', reason: 'auto_post_disabled' };
  if (settings.requireApproval) return { action: 'draft', reason: 'approval_required' };
  return { action: 'post', reason: 'auto_post' };
}

/** Re-checks the switches that must hold again right before publishing. */
export function canPublishNow(input: {
  global: GlobalSettingsDto;
  repoEnabled: boolean;
  settings: RepoSettingsDto;
  trigger: TriggerKind;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.global.automationEnabled) return { ok: false, reason: 'automation_disabled' };
  if (input.global.dryRun) return { ok: false, reason: 'dry_run_enabled' };
  if (!input.repoEnabled) return { ok: false, reason: 'repo_disabled' };
  if (!eventSwitchEnabled(input.settings, input.trigger)) {
    return { ok: false, reason: `event_disabled:${input.trigger}` };
  }
  return { ok: true };
}
