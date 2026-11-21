import { create } from 'zustand';
import type { BackgroundReason, BackgroundTaskRecord, Conversation } from '../types';
import { useChatStore } from './chat.store';
import { useInstallGateStore, isHolding } from './installGate.store';
import { useModelStore } from './model.store';
import { useSettingsStore } from './settings.store';
import { useLanguageStore } from './language.store';

export type { BackgroundStatus } from '../types';

export interface BackgroundTask extends BackgroundTaskRecord {
  conversationId: string;
  title: string;
}

export type BackgroundRunOutcome =
  | { status: 'done' | 'stopped' }
  | { status: 'waiting' | 'blocked'; reason: BackgroundReason }
  | { status: 'retry'; delayMs?: number };

export const backgroundRetryTiming = { baseMs: 2_000 };
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

interface BackgroundStore {
  tasks: Record<string, BackgroundTask>;
  launch: (content: string, opts?: { title?: string; source?: string }) => Promise<string | null>;
  markSeen: (conversationId: string) => void;
  remove: (conversationId: string) => void;
  jump: (conversationId: string) => void;
  init: (ready?: Promise<unknown>) => () => void;
}

function syncTasks(conversations: Conversation[]): void {
  const previous = useBackgroundStore.getState().tasks;
  const entries: [string, BackgroundTask][] = [];
  for (const { id, title, backgroundTask } of conversations) {
    if (!backgroundTask || backgroundTask.dismissed) continue;
    entries.push([id, { ...backgroundTask, conversationId: id, title }]);
  }
  if (entries.length || Object.keys(previous).length) {
    useBackgroundStore.setState({ tasks: Object.fromEntries(entries) });
  }
}

export async function updateBackgroundTask(id: string, patch: Partial<BackgroundTaskRecord>): Promise<void> {
  const chat = useChatStore.getState();
  const existing = chat.conversations.find((conversation) => conversation.id === id)?.backgroundTask;
  if (!existing) return;
  const backgroundTask = { ...existing, ...patch };
  // Change live state before the IPC await so a concurrent stop/resume observes
  // the latest intent. Main applies these updates in IPC send order.
  useChatStore.setState({
    conversations: chat.conversations.map((conversation) =>
      conversation.id === id ? { ...conversation, backgroundTask } : conversation),
  });
  await window.electronAPI.conversation.update(id, { backgroundTask });
}

export async function finishBackgroundRun(id: string, outcome: BackgroundRunOutcome): Promise<void> {
  const task = useChatStore.getState().conversations.find((conversation) => conversation.id === id)?.backgroundTask;
  if (!task || task.dismissed || task.status === 'stopped') return;
  if (outcome.status === 'retry') {
    const retryCount = (task.retryCount ?? 0) + 1;
    const backoff = Math.min(backgroundRetryTiming.baseMs * 2 ** Math.min(retryCount - 1, 16), MAX_BACKOFF_MS);
    await updateBackgroundTask(id, {
      status: 'running',
      retryCount,
      retryAt: Date.now() + Math.max(backoff, outcome.delayMs ?? 0),
    });
    return;
  }

  const done = outcome.status === 'done';
  await updateBackgroundTask(id, {
    status: outcome.status,
    reason: 'reason' in outcome ? outcome.reason : undefined,
    retryAt: undefined,
    retryCount: undefined,
    finishedAt: done ? Date.now() : null,
    unseen: done,
    reported: undefined,
  });
  const current = useChatStore.getState().conversations.find((conversation) => conversation.id === id);
  if (done && current?.backgroundTask?.status === 'done' && !current.backgroundTask.dismissed) {
    void window.electronAPI?.notification?.show?.({
      title: current.title,
      body: useLanguageStore.getState().t('backgroundDoneBody'),
      mode: useSettingsStore.getState().notificationMode ?? 'background',
    })?.catch(logFailure);
  }
}

function logFailure(error: unknown): void {
  console.error('[background] Could not update task:', error);
}

async function reportToParent(task: BackgroundTask): Promise<void> {
  const parentId = task.parentConversationId;
  if (!parentId) return;
  const messages = await window.electronAPI.message.list(task.conversationId);
  const reply = [...messages].reverse().find((message) =>
    message.role === 'assistant' && !message.isLocalNotice && message.content.trim());
  let summary = reply?.content.trim().slice(0, 4000) || '(the background run produced no output)';
  if (task.reason === 'question') {
    summary += '\n\nNOTE: the background run is waiting for the user to answer a question.';
  } else if (task.reason === 'approval') {
    summary += '\n\nNOTE: the background run is waiting for the user to review an action.';
  } else if (task.status === 'blocked' || task.status === 'stopped') {
    summary += `\n\nNOTE: the background run is ${task.status} and still needs attention.`;
  }
  // The message ID survives a restart between transcript delivery and marking
  // the report as delivered. Waiting and final results have distinct IDs.
  const reportId = `background:${task.conversationId}:${task.status}:${reply?.id ?? task.reason ?? ''}`;
  await useChatStore.getState().resumeAfterBackground(parentId, task.title, summary, reportId);
  const current = useChatStore.getState().conversations.find((item) => item.id === task.conversationId)?.backgroundTask;
  if (current?.status === task.status && current.reason === task.reason) {
    await updateBackgroundTask(task.conversationId, { reported: true });
  }
}

export const useBackgroundStore = create<BackgroundStore>((set, get) => ({
  tasks: {},

  launch: async (content, opts) => {
    const model = useModelStore.getState().getSelectedModel();
    if (!model || !content.trim()) return null;
    return useChatStore.getState().startBackgroundRun(content.trim(), model.providerId, model.id, opts);
  },

  markSeen: (id) => {
    if (get().tasks[id]?.unseen) void updateBackgroundTask(id, { unseen: false }).catch(logFailure);
  },

  remove: (id) => {
    const task = get().tasks[id];
    if (!task) return;
    void updateBackgroundTask(id, {
      dismissed: true,
      ...(task.status === 'done' ? {} : { status: 'stopped', reason: undefined, retryAt: undefined, reported: undefined }),
    }).catch(logFailure);
    if (useChatStore.getState().streamingRuns[id]) useChatStore.getState().stopGeneration(id);
  },

  jump: (id) => {
    if (!get().tasks[id]) return;
    get().markSeen(id);
    void useChatStore.getState().setActiveConversation(id);
  },

  init: (ready = Promise.resolve()) => {
    let enabled = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recovering = new Set<string>();
    const reporting = new Set<string>();
    const startupWaiting = new Set<string>();
    const recoveryRetryAt = new Map<string, number>();
    const reportRetryAt = new Map<string, number>();

    const scheduledTasks = () => useChatStore.getState().conversations.flatMap(({ id, title, backgroundTask }) =>
      backgroundTask && (!backgroundTask.dismissed || (backgroundTask.parentConversationId && !backgroundTask.reported))
        ? [{ ...backgroundTask, conversationId: id, title }] : []);
    const canRecover = (task: BackgroundTask) => !task.dismissed && !recovering.has(task.conversationId)
      && (task.status === 'running' || (task.status === 'waiting' && startupWaiting.has(task.conversationId)));
    const recoveryDeadline = (task: BackgroundTask) => Math.max(task.retryAt ?? 0, recoveryRetryAt.get(task.conversationId) ?? 0);
    const canReport = (task: BackgroundTask, runs: ReturnType<typeof useChatStore.getState>['streamingRuns']) => {
      const id = task.conversationId;
      const parent = task.parentConversationId;
      return parent && !task.reported && task.status !== 'running' && task.reason !== 'delegation'
        && !runs[id] && !runs[parent] && !reporting.has(id) && !(task.status === 'waiting' && startupWaiting.has(id));
    };

    const schedule = () => {
      clearTimeout(timer);
      if (!enabled || disposed || isHolding(useInstallGateStore.getState().jobs)) return;
      const { streamingRuns } = useChatStore.getState();
      const now = Date.now();
      let deadline = Infinity;
      for (const task of scheduledTasks()) {
        const id = task.conversationId;
        if (!streamingRuns[id] && canRecover(task)) {
          deadline = Math.min(deadline, recoveryDeadline(task));
        }
        if (canReport(task, streamingRuns)) {
          deadline = Math.min(deadline, reportRetryAt.get(id) ?? 0);
        }
      }
      if (Number.isFinite(deadline)) timer = setTimeout(runDue, Math.min(MAX_TIMER_MS, Math.max(0, deadline - now)));
    };

    const runDue = () => {
      if (disposed || isHolding(useInstallGateStore.getState().jobs)) return;
      const chat = useChatStore.getState();
      const now = Date.now();
      for (const task of scheduledTasks()) {
        const id = task.conversationId;
        if (!chat.streamingRuns[id] && canRecover(task) && recoveryDeadline(task) <= now) {
          recovering.add(id);
          const resume = startupWaiting.has(id) ? chat.resumeBackgroundRun(id, true) : chat.resumeBackgroundRun(id);
          void resume.then(() => {
            startupWaiting.delete(id);
            const current = get().tasks[id];
            if (current?.status === 'running' && current.retryAt == null && !useChatStore.getState().streamingRuns[id]) {
              // The detached launch may still be writing its first message.
              recoveryRetryAt.set(id, Date.now() + 250);
            } else {
              recoveryRetryAt.delete(id);
            }
          }, (error) => {
            logFailure(error);
            recoveryRetryAt.set(id, Date.now() + MAX_BACKOFF_MS);
          }).finally(() => {
            recovering.delete(id);
            schedule();
          });
        }
        if (canReport(task, useChatStore.getState().streamingRuns) && (reportRetryAt.get(id) ?? 0) <= now) {
          reporting.add(id);
          void reportToParent(task).then(
            () => { reportRetryAt.delete(id); },
            (error) => { logFailure(error); reportRetryAt.set(id, Date.now() + MAX_BACKOFF_MS); },
          ).finally(() => {
            reporting.delete(id);
            schedule();
          });
        }
      }
      schedule();
    };

    syncTasks(useChatStore.getState().conversations);
    const unsubscribeChat = useChatStore.subscribe((state, previous) => {
      const changed = state.conversations !== previous.conversations;
      if (changed) syncTasks(state.conversations);
      if (changed || state.isStreaming !== previous.isStreaming
        || (state.streamingRuns !== previous.streamingRuns
          && Object.keys(state.streamingRuns).length !== Object.keys(previous.streamingRuns).length)) schedule();
    });
    const unsubscribeInstall = useInstallGateStore.subscribe((state, previous) => {
      if (state.jobs !== previous.jobs) schedule();
    });
    const unsubscribeModel = useModelStore.subscribe((state, previous) => {
      if (state.models !== previous.models && enabled) {
        const readyModels = state.models;
        for (const conversation of useChatStore.getState().conversations) {
          const task = conversation.backgroundTask;
          if (task?.status !== 'blocked' || task.reason !== 'configuration' || task.dismissed) continue;
          const models = readyModels.get(conversation.providerId);
          if (models?.some((model) => model.id === conversation.modelId && model.enabled)
            && models !== previous.models.get(conversation.providerId)) {
            void updateBackgroundTask(conversation.id, { status: 'running', reason: undefined, retryAt: undefined }).catch(logFailure);
          }
        }
      }
    });
    void ready.then(() => {
      if (disposed) return;
      for (const task of scheduledTasks()) {
        if (task.status === 'waiting') startupWaiting.add(task.conversationId);
      }
      enabled = true;
      schedule();
    }, logFailure);
    return () => {
      disposed = true;
      unsubscribeChat();
      unsubscribeInstall();
      unsubscribeModel();
      clearTimeout(timer);
    };
  },
}));
