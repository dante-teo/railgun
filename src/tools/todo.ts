import { registry } from "./registry.js";
import type { ToolContext, ToolRunResult } from "./registry.js";

export const TODO_NODE_LIMIT = 256;
export const TODO_CONTENT_LIMIT = 4000;
export const TODO_TRUNCATION_MARKER = "\n[truncated]";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status?: TodoStatus;
  children?: readonly TodoItem[];
}

export type NormalizedTodoItem = Readonly<{
  id: string;
  content: string;
  status: TodoStatus;
  children?: readonly NormalizedTodoItem[];
}>;

export type TodoState = readonly NormalizedTodoItem[];

export interface TodoWriteInput {
  todos?: unknown;
  merge?: unknown;
}

export interface TodoWriteResult {
  todos: TodoState;
  summary: TodoSummary;
}

export interface TodoStore {
  read(): TodoState;
  write(input: TodoWriteInput): TodoWriteResult;
  formatForInjection(): string;
}

export interface TodoProgress {
  done: number;
  total: number;
}

export interface TodoSummary {
  total: number;
  completed: number;
  active: number;
}

const VALID_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeStatus = (value: unknown): TodoStatus =>
  typeof value === "string" && VALID_STATUSES.has(value as TodoStatus) ? (value as TodoStatus) : "pending";

const normalizeText = (value: unknown): string => {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return text.length > TODO_CONTENT_LIMIT ? `${text.slice(0, TODO_CONTENT_LIMIT)}${TODO_TRUNCATION_MARKER}` : text;
};

const normalizeId = (value: unknown): string | null => {
  const text = normalizeText(value).trim();
  return text === "" ? null : text;
};

interface NormalizeAccumulator {
  seenIds: ReadonlySet<string>;
  count: number;
}

const appendSeen = (seenIds: ReadonlySet<string>, id: string): ReadonlySet<string> => new Set([...seenIds, id]);

const normalizeNode = (
  value: unknown,
  accumulator: NormalizeAccumulator
): readonly [NormalizedTodoItem | null, NormalizeAccumulator] => {
  if (!isRecord(value) || accumulator.count >= TODO_NODE_LIMIT) return [null, accumulator];

  const id = normalizeId(value.id);
  if (id === null || accumulator.seenIds.has(id)) return [null, accumulator];

  const content = normalizeText(value.content);
  if (content.trim() === "") return [null, accumulator];

  const status = normalizeStatus(value.status);
  const nextAccumulator = { seenIds: appendSeen(accumulator.seenIds, id), count: accumulator.count + 1 };
  const rawChildren = Array.isArray(value.children) ? value.children : [];
  const [children, finalAccumulator] = rawChildren.reduce<readonly [readonly NormalizedTodoItem[], NormalizeAccumulator]>(
    ([items, acc], child) => {
      const [normalized, next] = normalizeNode(child, acc);
      return normalized === null ? [items, next] : [[...items, normalized], next];
    },
    [[], nextAccumulator]
  );

  return [
    children.length > 0 ? { id, content, status, children } : { id, content, status },
    finalAccumulator
  ];
};

export const normalizeTodoState = (value: unknown): TodoState => {
  const rawItems = Array.isArray(value) ? value : [];
  const [items] = rawItems.reduce<readonly [readonly NormalizedTodoItem[], NormalizeAccumulator]>(
    ([normalizedItems, accumulator], item) => {
      const [normalized, next] = normalizeNode(item, accumulator);
      return normalized === null ? [normalizedItems, next] : [[...normalizedItems, normalized], next];
    },
    [[], { seenIds: new Set<string>(), count: 0 }]
  );
  return items;
};

const flattenTodos = (todos: TodoState): readonly NormalizedTodoItem[] =>
  todos.flatMap(todo => [todo, ...flattenTodos(todo.children ?? [])]);

export const summarizeTodos = (todos: TodoState): TodoSummary => {
  const flattened = flattenTodos(todos);
  return {
    total: flattened.length,
    completed: flattened.filter(todo => todo.status === "completed").length,
    active: flattened.filter(todo => todo.status === "pending" || todo.status === "in_progress").length
  };
};

export const deriveTodoProgress = (todo: NormalizedTodoItem): TodoProgress => {
  const children = todo.children ?? [];
  if (children.length === 0) return { done: todo.status === "completed" ? 1 : 0, total: 1 };
  const progresses = children.map(deriveTodoProgress);
  return {
    done: progresses.reduce((sum, progress) => sum + progress.done, 0),
    total: progresses.reduce((sum, progress) => sum + progress.total, 0)
  };
};

const mergeNode = (node: NormalizedTodoItem, updates: ReadonlyMap<string, NormalizedTodoItem>): NormalizedTodoItem => {
  const updated = updates.get(node.id);
  const base = updated ? { ...node, content: updated.content, status: updated.status } : node;
  const children = (base.children ?? node.children ?? []).map(child => mergeNode(child, updates));
  return children.length > 0 ? { ...base, children } : { id: base.id, content: base.content, status: base.status };
};

const existingIds = (todos: TodoState): ReadonlySet<string> => new Set(flattenTodos(todos).map(todo => todo.id));

const mergeTodos = (current: TodoState, incoming: TodoState): TodoState => {
  const incomingFlat = flattenTodos(incoming);
  const updates = new Map(incomingFlat.map(todo => [todo.id, todo]));
  const mergedCurrent = current.map(todo => mergeNode(todo, updates));
  const ids = existingIds(current);
  const additions = incoming.filter(todo => !ids.has(todo.id));
  return normalizeTodoState([...mergedCurrent, ...additions]);
};

const activeTodo = (todo: NormalizedTodoItem): NormalizedTodoItem | null => {
  const children = (todo.children ?? []).map(activeTodo).filter((child): child is NormalizedTodoItem => child !== null);
  if (children.length > 0) return { ...todo, children };
  return todo.status === "pending" || todo.status === "in_progress" ? { id: todo.id, content: todo.content, status: todo.status } : null;
};

const activeTodos = (todos: TodoState): TodoState =>
  todos.map(activeTodo).filter((todo): todo is NormalizedTodoItem => todo !== null);

const formatTodoLine = (todo: NormalizedTodoItem, depth: number): readonly string[] => {
  const indent = "  ".repeat(depth);
  const children = todo.children ?? [];
  const marker = todo.status === "in_progress" ? "[~]" : "[ ]";
  const ownLine = `${indent}${marker} (${todo.id}) ${todo.content}`;
  return [ownLine, ...children.flatMap(child => formatTodoLine(child, depth + 1))];
};

const formatForInjection = (todos: TodoState): string => {
  const active = activeTodos(todos);
  return active.length === 0 ? "" : ["Current active todos:", ...active.flatMap(todo => formatTodoLine(todo, 0))].join("\n");
};

export const createTodoStore = (initialState: unknown = []): TodoStore => {
  let state = normalizeTodoState(initialState);
  return {
    read: () => state,
    write: input => {
      const incoming = normalizeTodoState(input.todos);
      state = input.merge === true ? mergeTodos(state, incoming) : incoming;
      return { todos: state, summary: summarizeTodos(state) };
    },
    formatForInjection: () => formatForInjection(state)
  };
};

const todoTool = async (args: unknown, context: ToolContext): Promise<ToolRunResult> => {
  const store = context.todoStore;
  if (!store) return { content: "Error: todo store is unavailable", isError: true };
  if (!isRecord(args) || !("todos" in args)) {
    const todos = store.read() as TodoState;
    return { content: JSON.stringify({ todos, summary: summarizeTodos(todos) }), isError: false };
  }
  const result = store.write({ todos: args.todos, merge: args.merge });
  return { content: JSON.stringify(result), isError: false };
};

registry.register({
  name: "todo",
  toolset: "planning",
  schema: {
    name: "todo",
    description:
      "Read or update the current in-memory nested todo list. Omit todos to read. Provide todos to replace, or merge:true to update by globally unique id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        merge: { type: "boolean", description: "When true, merge items by id instead of replacing the full tree." },
        todos: {
          type: "array",
          description: "Nested todo items with globally unique ids.",
          items: { type: "object", additionalProperties: true }
        }
      }
    }
  },
  handler: todoTool,
  verb: "Updating todos",
  previewArgKey: "todos"
});
