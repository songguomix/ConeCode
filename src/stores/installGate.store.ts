import { create } from 'zustand';

export type InstallKind = 'download' | 'tool' | 'model' | 'skill' | 'dep';

export interface InstallJob {
  id: string;
  label: string;
  kind: InstallKind;
  startedAt: number;
}

interface InstallGateState {
  /** Active installs — any entry means the model should hold. */
  jobs: Record<string, InstallJob>;
  /** Conversation whose run was stopped because an install started. */
  heldConversationId: string | null;
  /** Set when we held a live run; cleared after one auto-continue. */
  resumePending: boolean;
  begin: (id: string, label: string, kind?: InstallKind) => void;
  end: (id: string) => void;
  /** Remember that this conversation should continue after installs finish. */
  markResume: (conversationId: string) => void;
  /** Clear hold; returns the conversation to auto-continue, or null. */
  release: () => string | null;
  reset: () => void;
}

function hasJobs(jobs: Record<string, InstallJob>): boolean {
  return Object.keys(jobs).length > 0;
}

export const useInstallGateStore = create<InstallGateState>((set, get) => ({
  jobs: {},
  heldConversationId: null,
  resumePending: false,

  begin: (id, label, kind = 'download') => {
    set((s) => ({
      jobs: {
        ...s.jobs,
        [id]: { id, label, kind, startedAt: Date.now() },
      },
    }));
  },

  end: (id) => {
    set((s) => {
      if (!s.jobs[id]) return s;
      const jobs = { ...s.jobs };
      delete jobs[id];
      return { jobs };
    });
  },

  markResume: (conversationId) => {
    set({ heldConversationId: conversationId, resumePending: true });
  },

  release: () => {
    const { jobs, resumePending, heldConversationId } = get();
    if (hasJobs(jobs)) return null; // still installing — keep holding
    if (!resumePending) return null;
    set({ resumePending: false, heldConversationId: null });
    return heldConversationId;
  },

  reset: () => set({ jobs: {}, heldConversationId: null, resumePending: false }),
}));

export function activeInstallLabel(jobs: Record<string, InstallJob>): string | null {
  const list = Object.values(jobs).sort((a, b) => a.startedAt - b.startedAt);
  return list.length ? list[list.length - 1].label : null;
}

export function isHolding(jobs: Record<string, InstallJob>): boolean {
  return hasJobs(jobs);
}
