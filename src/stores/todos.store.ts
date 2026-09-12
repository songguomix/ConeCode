import { create } from 'zustand';

// A live to-do checklist the agent maintains via the `update_todos` action,
// rendered above the chat input (Codex / Claude Code style). Ephemeral: it
// tracks the current task and is cleared when the conversation changes.

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

interface TodosStore {
  todos: TodoItem[];
  // Items the USER deleted. update_todos replaces the whole list every call, so
  // without this the agent's next update would resurrect anything dismissed —
  // deleting an item would appear to do nothing a few seconds later.
  dismissed: string[];
  setTodos: (todos: TodoItem[]) => void;
  removeTodo: (index: number) => void;
  clearTodos: () => void;
}

const key = (content: string) => content.trim().toLowerCase();

export const useTodosStore = create<TodosStore>((set, get) => ({
  todos: [],
  dismissed: [],

  setTodos: (todos) => {
    const dropped = new Set(get().dismissed);
    set({ todos: todos.filter((td) => !dropped.has(key(td.content))) });
  },

  removeTodo: (index) => {
    const target = get().todos[index];
    if (!target) return;
    set((s) => ({
      todos: s.todos.filter((_, i) => i !== index),
      dismissed: [...s.dismissed, key(target.content)],
    }));
  },

  // Also forgets the dismissal list: a new conversation starts from scratch.
  clearTodos: () => set({ todos: [], dismissed: [] }),
}));
