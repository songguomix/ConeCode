import { create } from 'zustand';
import { useChatStore } from './chat.store';
import { useModelStore } from './model.store';
import { useSettingsStore } from './settings.store';
import { useLanguageStore } from './language.store';

export type BackgroundStatus = 'running' | 'done';

/** Runs that never showed up in streamingRuns die silently (instant crash). */
const UNOBSERVED_TIMEOUT_MS = 30_000;

export interface BackgroundTask {
  conversationId: string;
  title: string;
  status: BackgroundStatus;
  /** Seen alive in streamingRuns at least once (guards the start race). */
  observed: boolean;
  startedAt: number;
  finishedAt: number | null;
  /** Finished but the user hasn't opened it yet (panel dot + jump target). */
  unseen: boolean;
  /** Who dispatched it: 'chat' (composer) or a plugin skill id. */
  source: string;
  /**
   * Agent-delegated runs report back here: when this task finishes, its
   * result is appended to the parent conversation and that run resumes.
   */
  parentConversationId?: string;
}

interface BackgroundStore {
  tasks: Record<string, BackgroundTask>;
  /** OpenCode-style dispatch: run this text in a fresh conversation, stay here. */
  launch: (content: string, opts?: { title?: string; source?: string }) => Promise<string | null>;
  /** Register an already-started run (also the unit-test seam). */
  register: (conversationId: string, title: string, source?: string, parentConversationId?: string) => void;
  /**
   * Claim a detached run the agent started via `run_background`
   * (also the unit-test seam for delegation).
   */
  adopt: (conversationId: string, opts: { title: string; parentConversationId: string }) => void;
  /** Reconcile with chat streamingRuns (also the unit-test seam). */
  sync: () => void;
  markSeen: (conversationId: string) => void;
  remove: (conversationId: string) => void;
  /** Open the conversation and clear its badge. */
  jump: (conversationId: string) => void;
  /** Subscribe to chat runs; call once at boot. Returns unsubscribe. */
  init: () => () => void;
}

function notifyDone(task: BackgroundTask): void {
  try {
    const t = useLanguageStore.getState().t;
    const mode = useSettingsStore.getState().notificationMode ?? 'background';
    void (window as any).electronAPI?.notification?.show?.({
      title: task.title,
      body: t('backgroundDoneBody'),
      mode,
    });
  } catch {}
}

/**
 * Read a finished delegated run and hand its result to the parent
 * conversation. Stall states are reported, not hidden: an approval the user
 * still has to clear, or a question the run asked, arrives as a note so the
 * parent asks the user instead of assuming success.
 */
async function wakeParent(task: BackgroundTask): Promise<void> {
  const parentId = task.parentConversationId;
  if (!parentId) return;
  let summary = '(the background run produced no output)';
  try {
    const msgs = ((await (window as any).electronAPI?.message?.list?.(task.conversationId)) || []) as any[];
    const lastAssistant = [...msgs].reverse().find((m) => m?.role === 'assistant' && String(m.content || '').trim());
    if (lastAssistant) summary = String(lastAssistant.content).trim().slice(0, 4000);
    const last = msgs[msgs.length - 1];
    if (last?.isQuestion) {
      summary += '\n\nNOTE: the background run is waiting for the user to answer a question — ask them before continuing.';
    } else {
      try {
        const { useCodeChangesStore } = await import('./codeChanges.store');
        const pending = useCodeChangesStore.getState().changes.some(
          (c) => c.conversationId === task.conversationId && c.status === 'pending',
        );
        if (pending) {
          summary += '\n\nNOTE: the background run proposed changes awaiting user approval — ask the user to open that conversation and approve or reject them.';
        }
      } catch {}
    }
  } catch {}
  try {
    await useChatStore.getState().resumeAfterBackground(parentId, task.title, summary);
  } catch {}
}

export const useBackgroundStore = create<BackgroundStore>((set, get) => ({
  tasks: {},

  launch: async (content, opts) => {
    const text = content.trim();
    if (!text) return null;
    const model = useModelStore.getState().getSelectedModel();
    if (!model) return null;
    const id = await useChatStore.getState().startBackgroundRun(text, model.providerId, model.id);
    if (!id) return null;
    get().register(id, opts?.title || text.replace(/\s+/g, ' ').slice(0, 50), opts?.source || 'chat');
    get().sync();
    return id;
  },

  register: (conversationId, title, source, parentConversationId) => {
    if (get().tasks[conversationId]) return;
    set((s) => ({
      tasks: {
        ...s.tasks,
        [conversationId]: {
          conversationId,
          title,
          status: 'running',
          observed: false,
          startedAt: Date.now(),
          finishedAt: null,
          unseen: false,
          source: source || 'chat',
          parentConversationId,
        },
      },
    }));
  },

  adopt: (conversationId, opts) => {
    get().register(conversationId, opts.title, 'agent', opts.parentConversationId);
    get().sync();
  },

  sync: () => {
    const runs = useChatStore.getState().streamingRuns;
    const now = Date.now();
    let changed = false;
    const tasks = { ...get().tasks };
    for (const [id, task] of Object.entries(tasks)) {
      if (task.status !== 'running') continue;
      if ((runs as Record<string, unknown>)[id]) {
        if (!task.observed) {
          tasks[id] = { ...task, observed: true };
          changed = true;
        }
        continue;
      }
      if (!task.observed && now - task.startedAt < UNOBSERVED_TIMEOUT_MS) continue;
      tasks[id] = { ...task, status: 'done', finishedAt: now, unseen: true };
      changed = true;
      notifyDone(tasks[id]);
      // Agent-delegated runs wake their parent: the result goes back into
      // that conversation and its run resumes. Fire and forget — the status
      // above is already committed, so a second sync can never double-wake.
      if (task.parentConversationId) void wakeParent(tasks[id]);
    }
    if (changed) set({ tasks });
  },

  markSeen: (conversationId) => {
    const task = get().tasks[conversationId];
    if (!task?.unseen) return;
    set((s) => ({
      tasks: { ...s.tasks, [conversationId]: { ...task, unseen: false } },
    }));
  },

  remove: (conversationId) => {
    const task = get().tasks[conversationId];
    if (!task) return;
    if (task.status === 'running') {
      try {
        useChatStore.getState().stopGeneration(conversationId);
      } catch {}
    }
    set((s) => {
      const tasks = { ...s.tasks };
      delete tasks[conversationId];
      return { tasks };
    });
  },

  jump: (conversationId) => {
    if (!get().tasks[conversationId]) return;
    get().markSeen(conversationId);
    void useChatStore.getState().setActiveConversation(conversationId);
  },

  init: () => {
    get().sync();
    return useChatStore.subscribe(() => get().sync());
  },
}));
