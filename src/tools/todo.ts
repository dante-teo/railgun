import { registry } from "./registry.js";
import type { ToolContext, ToolRunResult } from "./registry.js";

export const TODO_NODE_LIMIT = 256;
export const TODO_CONTENT_LIMIT = 4000;
export const TODO_TRUNCATION_MARKER = "… [truncated]";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status?: TodoStatus;
}

export type NormalizedTodoItem = Readonly<{
  id: string;
  content: string;
  status: TodoStatus;
}>;

export type TodoState = readonly NormalizedTodoItem[];

export interface TodoWriteInput {
  todos?: unknown;
  merge?: unknown;
}

export interface TodoSummary {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
  cancelled: number;
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

const VALID_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeStatus = (value: unknown): TodoStatus => {
  if (typeof value !== "string") return "pending";
  const lower = value.trim().toLowerCase();
  return VALID_STATUSES.has(lower as TodoStatus) ? (lower as TodoStatus) : "pending";
};

// Hermes todo_tool.py:153-156: total length ≤ TODO_CONTENT_LIMIT
const capContent = (content: string): string => {
  if (content.length <= TODO_CONTENT_LIMIT) return content;
  const keep = TODO_CONTENT_LIMIT - TODO_TRUNCATION_MARKER.length;
  return content.slice(0, keep) + TODO_TRUNCATION_MARKER;
};

// --- Hermes-aligned _validate (todo_tool.py:158-183) ---
// Coerces malformed items into valid ones instead of dropping them.
const validateItem = (item: unknown): NormalizedTodoItem => {
  if (!isRecord(item)) return { id: "?", content: "(invalid item)", status: "pending" };

  const rawId = typeof item.id === "string" ? item.id.trim() : item.id === undefined || item.id === null ? "" : String(item.id).trim();
  const id = rawId === "" ? "?" : rawId;

  const rawContent = typeof item.content === "string" ? item.content.trim() : item.content === undefined || item.content === null ? "" : String(item.content).trim();
  const content = rawContent === "" ? "(no description)" : capContent(rawContent);

  return { id, content, status: normalizeStatus(item.status) };
};

// --- Hermes-aligned _dedupe_by_id (todo_tool.py:186-196) ---
// Runs BEFORE validation on raw items. Non-dict items get synthetic keys
// so they survive dedupe independently (two non-dicts both survive; a
// non-dict and a blank-id dict both survive).
const dedupeById = (todos: readonly unknown[]): readonly unknown[] => {
  const lastIndex = new Map<string, number>();
  for (let i = 0; i < todos.length; i++) {
    const item = todos[i];
    if (!isRecord(item)) {
      lastIndex.set(`__invalid_${i}`, i);
      continue;
    }
    const rawId = typeof item.id === "string" ? item.id.trim() : item.id === undefined || item.id === null ? "" : String(item.id).trim();
    const key = rawId === "" ? "?" : rawId;
    lastIndex.set(key, i);
  }
  return [...lastIndex.values()].sort((a, b) => a - b).map(i => todos[i]);
};

// Replace mode: dedupe raw → validate each → cap at limit.
export const normalizeTodoState = (value: unknown): TodoState => {
  const rawItems = Array.isArray(value) ? value : [];
  return dedupeById(rawItems).map(validateItem).slice(0, TODO_NODE_LIMIT);
};

export const summarizeTodos = (todos: TodoState): TodoSummary => ({
  total: todos.length,
  pending: todos.filter(t => t.status === "pending").length,
  in_progress: todos.filter(t => t.status === "in_progress").length,
  completed: todos.filter(t => t.status === "completed").length,
  cancelled: todos.filter(t => t.status === "cancelled").length,
});

// --- Hermes-aligned merge (todo_tool.py:66-101) ---
// Update existing items by id (partial fields), append new ones.
const mergeTodos = (current: TodoState, incoming: readonly unknown[]): TodoState => {
  const deduped = dedupeById(incoming);
  const existing = new Map(current.map(item => [item.id, { ...item }]));
  const appendOrder: NormalizedTodoItem[] = [];

  for (const raw of deduped) {
    if (!isRecord(raw)) continue; // Can't merge a non-dict — no id to match on

    const rawId = typeof raw.id === "string" ? raw.id.trim() : raw.id === undefined || raw.id === null ? "" : String(raw.id).trim();
    if (rawId === "") continue; // Can't merge without an id (Hermes: line 71-72)

    if (existing.has(rawId)) {
      // Update only the fields the LLM actually provided (Hermes: lines 75-81)
      const entry = existing.get(rawId)!;
      if ("content" in raw && raw.content) {
        const c = typeof raw.content === "string" ? raw.content.trim() : String(raw.content).trim();
        if (c !== "") entry.content = capContent(c);
      }
      if ("status" in raw && raw.status) {
        const s = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : String(raw.status).trim().toLowerCase();
        if (VALID_STATUSES.has(s as TodoStatus)) entry.status = s as TodoStatus;
      }
    } else {
      // New item — validate fully and append (Hermes: lines 83-86)
      const validated = validateItem(raw);
      existing.set(validated.id, validated);
      appendOrder.push(validated);
    }
  }

  // Rebuild preserving order for existing items, then appended new ones (Hermes: lines 88-95)
  const seen = new Set<string>();
  const rebuilt: NormalizedTodoItem[] = [];
  for (const item of current) {
    const entry = existing.get(item.id) ?? item;
    if (!seen.has(entry.id)) {
      rebuilt.push({ id: entry.id, content: entry.content, status: entry.status });
      seen.add(entry.id);
    }
  }
  for (const item of appendOrder) {
    if (!seen.has(item.id)) {
      rebuilt.push(item);
      seen.add(item.id);
    }
  }

  return rebuilt.slice(0, TODO_NODE_LIMIT);
};

// --- Hermes-aligned format_for_injection (todo_tool.py:111-143) ---
// Wire-format glyphs from todo_tool.py:122-127 (cancelled = "[~]")
const INJECTION_MARKERS: Record<TodoStatus, string> = {
  completed: "[x]",
  in_progress: "[>]",
  pending: "[ ]",
  cancelled: "[~]",
};

const formatForInjection = (todos: TodoState): string => {
  const active = todos.filter(t => t.status === "pending" || t.status === "in_progress");
  if (active.length === 0) return "";
  const lines = ["[Your active task list was preserved across context compression]"];
  for (const item of active) {
    const marker = INJECTION_MARKERS[item.status] ?? "[?]";
    lines.push(`- ${marker} ${item.id}. ${item.content} (${item.status})`);
  }
  return lines.join("\n");
};

export const createTodoStore = (initialState: unknown = []): TodoStore => {
  let state = normalizeTodoState(initialState);
  return {
    read: () => state,
    write: input => {
      const raw = Array.isArray(input.todos) ? input.todos : [];
      state = input.merge === true ? mergeTodos(state, raw) : normalizeTodoState(input.todos);
      return { todos: state, summary: summarizeTodos(state) };
    },
    formatForInjection: () => formatForInjection(state),
  };
};

const todoTool = async (args: unknown, context: ToolContext): Promise<ToolRunResult> => {
  const store = context.todoStore;
  if (!store) return { content: "Error: todo store is unavailable", isError: true };
  if (!isRecord(args) || !("todos" in args) || args.todos == null) {
    const todos = store.read() as TodoState;
    return { content: JSON.stringify({ todos, summary: summarizeTodos(todos) }), isError: false };
  }
  // Hermes todo_tool.py:218-228: parse JSON strings, reject other non-lists
  let todos = args.todos;
  if (typeof todos === "string") {
    try { todos = JSON.parse(todos); } catch { return { content: "Error: todos must be a list of objects, got unparseable string", isError: true }; }
  }
  if (!Array.isArray(todos)) {
    return { content: `Error: todos must be a list, got ${typeof todos}`, isError: true };
  }
  const result = store.write({ todos, merge: args.merge });
  return { content: JSON.stringify(result), isError: false };
};

registry.register({
  name: "todo",
  toolset: "planning",
  schema: {
    name: "todo",
    description:
      "Manage your task list for the current session. Use for complex tasks with 3+ steps or when the user provides multiple tasks. Call with no parameters to read the current list.\n\nWriting:\n- Provide 'todos' array to create/update items\n- merge=false (default): replace the entire list with a fresh plan\n- merge=true: update existing items by id, add any new ones\n\nEach item: {id: string, content: string, status: pending|in_progress|completed|cancelled}\nList order is priority. Only ONE item in_progress at a time.\nMark items completed immediately when done. If something fails, cancel it and add a revised item.\n\nAlways returns the full current list.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        merge: {
          type: "boolean",
          description: "true: update existing items by id, add new ones. false (default): replace the entire list.",
        },
        todos: {
          type: "array",
          description: "Task items to write. Omit to read current list.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique item identifier" },
              content: { type: "string", description: "Task description" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"],
                description: "Current status",
              },
            },
            required: ["id", "content", "status"],
          },
        },
      },
    },
  },
  handler: todoTool,
  verb: "Updating todos",
  previewArgKey: "todos",
});
