import { FiAlertCircle, FiCheck, FiClock, FiLoader, FiSlash } from 'react-icons/fi';
import type { BackgroundTask } from '../../stores/background.store';

const status = {
  running: { label: 'backgroundRunning', Icon: FiLoader, color: 'text-[var(--accent)] animate-spin' },
  retrying: { label: 'backgroundRetrying', Icon: FiClock, color: 'text-[var(--accent)]' },
  waiting: { label: 'backgroundWaiting', Icon: FiClock, color: 'text-[var(--warning)]' },
  done: { label: 'backgroundDone', Icon: FiCheck, color: 'text-[var(--success)]' },
  stopped: { label: 'backgroundStopped', Icon: FiSlash, color: 'text-[var(--text-muted)]' },
  blocked: { label: 'backgroundBlocked', Icon: FiAlertCircle, color: 'text-[var(--error)]' },
};

const reasonLabel = {
  question: 'waitingForAnswer',
  approval: 'pendingApproval',
  delegation: 'backgroundWaitingForTasks',
  configuration: 'backgroundNeedsConfiguration',
  budget: 'backgroundBudgetReached',
  interrupted: 'backgroundInterrupted',
};

function getStatus(task: BackgroundTask) {
  return status[task.status === 'running' && task.retryAt != null ? 'retrying' : task.status];
}

export function backgroundTaskStatusKey(task: BackgroundTask): string {
  if ((task.status === 'waiting' || task.status === 'blocked') && task.reason) {
    return reasonLabel[task.reason];
  }
  return getStatus(task).label;
}

export function BackgroundTaskStatusIcon({ task, size }: { task: BackgroundTask; size: number }) {
  const { Icon, color } = getStatus(task);
  return <Icon size={size} className={`${color} shrink-0`} aria-hidden="true" />;
}
