import { useState } from 'react';
import { FiCheckCircle, FiCircle, FiLoader, FiChevronDown, FiChevronRight, FiCheckSquare, FiX, FiTrash2 } from 'react-icons/fi';
import { useTodosStore, useLanguageStore } from '../../stores';
import { summarizeTodos } from './todoPresentation';

// Live agent task checklist, pinned above the chat input. Hidden when empty.
export default function TodoList() {
  const todos = useTodosStore((s) => s.todos);
  const removeTodo = useTodosStore((s) => s.removeTodo);
  const clearTodos = useTodosStore((s) => s.clearTodos);
  const { t } = useLanguageStore();
  const [expanded, setExpanded] = useState(false);

  if (!todos.length) return null;
  const { done, total, percent, allDone, current } = summarizeTodos(todos);

  return (
    <div className="max-w-[900px] mx-auto w-full px-4 mb-1">
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] overflow-hidden group/todos shadow-sm">
      <div className="w-full flex items-center gap-2 px-2.5 py-1 text-xs text-[var(--text-secondary)] min-h-8">
        <button
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          title={expanded ? t('collapseTodos') : t('expandTodos')}
          className="flex items-center gap-1.5 min-w-0 flex-1 hover:text-[var(--text-primary)] transition-colors text-left"
        >
          {expanded ? <FiChevronDown size={11} /> : <FiChevronRight size={11} />}
          <FiCheckSquare size={12} className="text-[var(--accent)]" />
          <span className="font-medium shrink-0">{t('todos')}</span>
          <span className="text-[var(--border)] shrink-0">·</span>
          <span className={`truncate ${allDone ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}>
            {allDone ? t('allTodosCompleted') : current?.content}
          </span>
        </button>
        <div className="hidden sm:block w-14 h-1 rounded-full bg-[var(--bg-4)] overflow-hidden" aria-hidden="true">
          <div
            className={`h-full rounded-full transition-all ${allDone ? 'bg-[var(--success)]' : 'bg-[var(--accent)]'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className={`tabular-nums shrink-0 ${allDone ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}>
          {done}/{total}
        </span>
        <button
          onClick={clearTodos}
          title={t('clearTodos')}
          className="opacity-0 group-hover/todos:opacity-100 focus:opacity-100 p-0.5 rounded hover:bg-[var(--bg-3)] hover:text-[var(--error)] transition-all"
        >
          <FiTrash2 size={12} />
        </button>
      </div>
      {expanded && (
        <ul className="px-2.5 py-1.5 space-y-1 max-h-36 overflow-y-auto border-t border-[var(--border)]">
          {todos.map((td, i) => (
            <li key={`${td.content}-${i}`} className="group/todo flex items-start gap-1.5 text-xs leading-snug min-h-5">
              <span className="mt-0.5 shrink-0">
                {td.status === 'completed' ? (
                  <FiCheckCircle size={12} className="text-[var(--success)]" />
                ) : td.status === 'in_progress' ? (
                  <FiLoader size={12} className="text-[var(--accent)] animate-spin" />
                ) : (
                  <FiCircle size={12} className="text-[var(--text-muted)]" />
                )}
              </span>
              <span className={`flex-1 min-w-0 ${
                td.status === 'completed'
                  ? 'line-through text-[var(--text-muted)]'
                  : td.status === 'in_progress'
                    ? 'text-[var(--text-primary)] font-medium'
                    : 'text-[var(--text-secondary)]'
              }`}>
                {td.content}
              </span>
              <button
                onClick={() => removeTodo(i)}
                title={t('deleteTodo')}
                className="shrink-0 opacity-0 group-hover/todo:opacity-100 focus:opacity-100 p-0.5 rounded text-[var(--text-muted)] hover:bg-[var(--bg-3)] hover:text-[var(--error)] transition-all"
              >
                <FiX size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
    </div>
  );
}
