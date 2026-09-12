import type { TodoItem } from '../../stores/todos.store';

export interface TodoSummary {
  done: number;
  total: number;
  percent: number;
  allDone: boolean;
  current: TodoItem | null;
}

/** Pick the one line worth showing while the checklist is collapsed. */
export function summarizeTodos(todos: TodoItem[]): TodoSummary {
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const current = todos.find((todo) => todo.status === 'in_progress')
    || todos.find((todo) => todo.status === 'pending')
    || todos[todos.length - 1]
    || null;

  return {
    done,
    total: todos.length,
    percent: todos.length ? Math.round((done / todos.length) * 100) : 0,
    allDone: todos.length > 0 && done === todos.length,
    current,
  };
}
