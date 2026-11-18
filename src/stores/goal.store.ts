import { create } from 'zustand';

export type GoalStatus = 'running' | 'paused' | 'completed';

export interface ConversationGoal {
  conversationId: string;
  text: string;
  status: GoalStatus;
  pendingTodos?: number;
  elapsedMs?: number;
  runningSince?: number;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'conecode.goals.v1';

function loadGoals(): Record<string, ConversationGoal> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]: [string, any]) =>
      value && typeof value.text === 'string' && (value.status === 'running' || value.status === 'paused' || value.status === 'completed'),
    )) as Record<string, ConversationGoal>;
  } catch {
    return {};
  }
}

function saveGoals(goals: Record<string, ConversationGoal>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(goals)); } catch {}
}

interface GoalStore {
  goals: Record<string, ConversationGoal>;
  setGoal: (conversationId: string, text: string) => ConversationGoal;
  setPendingTodos: (conversationId: string, count: number) => void;
  updateGoal: (conversationId: string, text: string) => void;
  setStatus: (conversationId: string, status: GoalStatus) => void;
  clearGoal: (conversationId: string) => void;
}

export const useGoalStore = create<GoalStore>((set, get) => ({
  goals: loadGoals(),

  setGoal: (conversationId, text) => {
    const now = Date.now();
    const goal: ConversationGoal = {
      conversationId,
      text: text.trim(),
      status: 'running',
      elapsedMs: 0,
      runningSince: now,
      createdAt: now,
      updatedAt: now,
    };
    const goals = { ...get().goals, [conversationId]: goal };
    saveGoals(goals);
    set({ goals });
    return goal;
  },

  setPendingTodos: (conversationId, count) => {
    const current = get().goals[conversationId];
    if (!current || current.pendingTodos === count) return;
    const goals = { ...get().goals, [conversationId]: { ...current, pendingTodos: count } };
    saveGoals(goals);
    set({ goals });
  },

  updateGoal: (conversationId, text) => {
    const current = get().goals[conversationId];
    const trimmed = text.trim();
    if (!current || !trimmed) return;
    const goals = {
      ...get().goals,
      [conversationId]: { ...current, text: trimmed, updatedAt: Date.now() },
    };
    saveGoals(goals);
    set({ goals });
  },

  setStatus: (conversationId, status) => {
    const current = get().goals[conversationId];
    if (!current || current.status === status) return;
    const now = Date.now();
    const goals = {
      ...get().goals,
      [conversationId]: { ...current, status, updatedAt: now, elapsedMs: goalElapsed(current, now), runningSince: status === 'running' ? now : undefined },
    };
    saveGoals(goals);
    set({ goals });
  },

  clearGoal: (conversationId) => {
    if (!get().goals[conversationId]) return;
    const goals = { ...get().goals };
    delete goals[conversationId];
    saveGoals(goals);
    set({ goals });
  },
}));

export function goalElapsed(goal: ConversationGoal, now = Date.now()) {
  const accumulated = goal.elapsedMs ?? (goal.status === 'running' ? 0 : Math.max(0, goal.updatedAt - goal.createdAt));
  return accumulated + (goal.status === 'running' ? Math.max(0, now - (goal.runningSince ?? goal.createdAt)) : 0);
}

export function goalPrompt(text: string): string {
  return `${text.trim()}\n\nThis is an active long-running goal. Keep working until the outcome is complete. Preserve the current sandbox and approval policy. Verify the result against explicit tests or other concrete evidence before declaring completion; pause when user input is genuinely required.`;
}
