import React from "react";
import { summarizeTodos, type TodoState, type TodoStatus } from "@railgun/core/tools/todo.js";
import { glyphs } from "../lib/theme.js";

interface TodoPanelProps {
  readonly todos: TodoState;
  readonly isLoading: boolean;
}

const GLYPH: Record<TodoStatus, string> = {
  completed: glyphs.todoChecked,
  cancelled: glyphs.todoCancelled,
  in_progress: glyphs.todoInProgress,
  pending: glyphs.todoPending,
};

export const TodoPanel: React.FC<TodoPanelProps> = ({ todos, isLoading }) => {
  // Hidden when empty and not loading — matches App.tsx line 359 logic
  if (todos.length === 0 && !isLoading) return null;

  if (isLoading) {
    return (
      <div className="todo-panel" aria-busy="true" aria-label="Loading tasks">
        {[0, 1, 2].map(i => (
          <div key={i} className="skeleton" style={{ height: 14, width: `${60 + i * 10}%`, margin: "2px 0" }} />
        ))}
      </div>
    );
  }

  const summary = summarizeTodos(todos);

  return (
    <div className="todo-panel" aria-label="Task list">
      <div className="todo-panel__header">
        <span>Todos</span>
        <span className="todo-panel__summary">{summary.completed}/{summary.total}</span>
      </div>
      <div role="list">
        {todos.map(item => (
          <div
            key={item.id}
            className={`todo-item todo-item--${item.status}`}
            role="listitem"
            aria-label={`${item.status}: ${item.content}`}
          >
            <span className="todo-item__glyph" aria-hidden="true">{GLYPH[item.status]}</span>
            <span className="todo-item__content">{item.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
