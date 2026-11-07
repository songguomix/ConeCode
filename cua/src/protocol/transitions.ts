import { InvalidTransitionError } from './errors.js';
import { isTerminal, type TaskStatus } from './schemas.js';

/**
 * Explicit task state machine. Every controller transition goes through here.
 * `cancelRequested` is not a state: it is a flag while an in-flight action is
 * still being accounted for. A task is never reported cancelled while an action
 * may still be running.
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  created: ['observing', 'paused', 'recovering', 'failed', 'cancelled'],
  observing: ['planning', 'paused', 'cancelled', 'needs_attention', 'verifying_unknown', 'recovering', 'failed'],
  planning: ['executing', 'observing', 'awaiting_user', 'verifying', 'verifying_unknown', 'recovering', 'paused', 'cancelled', 'failed', 'needs_attention'],
  executing: ['verifying_action', 'observing', 'verifying_unknown', 'recovering', 'paused', 'cancelled', 'failed', 'needs_attention'],
  verifying_action: ['executing', 'observing', 'verifying', 'succeeded', 'failed', 'verifying_unknown', 'recovering', 'paused', 'cancelled', 'needs_attention'],
  verifying: ['executing', 'observing', 'succeeded', 'failed', 'verifying_unknown', 'recovering', 'paused', 'cancelled', 'needs_attention'],
  verifying_unknown: ['observing', 'recovering', 'succeeded', 'failed', 'needs_attention', 'cancelled'],
  recovering: ['observing', 'verifying_unknown', 'succeeded', 'failed', 'needs_attention', 'cancelled'],
  awaiting_user: ['observing', 'planning', 'executing', 'paused', 'recovering', 'cancelled', 'failed'],
  paused: ['observing', 'planning', 'verifying_unknown', 'recovering', 'cancelled', 'failed'],
  needs_attention: ['observing', 'recovering', 'paused', 'cancelled', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function assertNotTerminal(status: TaskStatus): void {
  if (isTerminal(status)) throw new InvalidTransitionError(status, 'observing');
}

export function nextStatuses(from: TaskStatus): readonly TaskStatus[] {
  return TRANSITIONS[from] ?? [];
}

export const TERMINAL = ['succeeded', 'failed', 'cancelled'] as const;
