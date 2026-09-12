import { create } from 'zustand';

export type GoalStatus = 'running' | 'paused';

export interface ConversationGoal {
  conversationId: string;
  text: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'conecode.goals.v1';

function loadGoals(): Record<string, ConversationGoal> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]: [string, any]) =>
      value && typeof value.text === 'string' && (value.status === 'running' || value.status === 'paused'),
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
      createdAt: now,
      updatedAt: now,
    };
    const goals = { ...get().goals, [conversationId]: goal };
    saveGoals(goals);
    set({ goals });
    return goal;
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
    const goals = {
      ...get().goals,
      [conversationId]: { ...current, status, updatedAt: Date.now() },
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

export function goalPrompt(text: string): string {
  return `${text.trim()}\n\nThis is an active long-running goal. Keep working until the outcome is complete. Preserve the current sandbox and approval policy. Verify the result against explicit tests or other concrete evidence before declaring completion; pause when user input is genuinely required.`;
}
