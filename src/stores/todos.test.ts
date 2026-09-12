import { describe, it, expect, beforeEach } from 'vitest';
import { useTodosStore } from './todos.store';

const list = () => useTodosStore.getState().todos;

describe('todo deletion', () => {
  beforeEach(() => useTodosStore.getState().clearTodos());

  it('removes the item at the given index', () => {
    useTodosStore.getState().setTodos([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]);
    useTodosStore.getState().removeTodo(1);
    expect(list().map((t) => t.content)).toEqual(['a', 'c']);
  });

  it('keeps a deleted item gone when the agent resends the list', () => {
    // update_todos replaces the whole list every call, so without the dismissal
    // set the next agent update would silently bring the item back.
    useTodosStore.getState().setTodos([{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }]);
    useTodosStore.getState().removeTodo(0);
    useTodosStore.getState().setTodos([
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'pending' },
    ]);
    expect(list().map((t) => t.content)).toEqual(['b', 'c']);
  });

  it('matches dismissals case- and whitespace-insensitively', () => {
    useTodosStore.getState().setTodos([{ content: 'Write tests', status: 'pending' }]);
    useTodosStore.getState().removeTodo(0);
    useTodosStore.getState().setTodos([{ content: '  write TESTS  ', status: 'pending' }]);
    expect(list()).toHaveLength(0);
  });

  it('forgets dismissals when the checklist is cleared for a new conversation', () => {
    useTodosStore.getState().setTodos([{ content: 'a', status: 'pending' }]);
    useTodosStore.getState().removeTodo(0);
    useTodosStore.getState().clearTodos();
    useTodosStore.getState().setTodos([{ content: 'a', status: 'pending' }]);
    expect(list()).toHaveLength(1);
  });

  it('ignores an out-of-range index', () => {
    useTodosStore.getState().setTodos([{ content: 'a', status: 'pending' }]);
    useTodosStore.getState().removeTodo(9);
    expect(list()).toHaveLength(1);
  });
});
