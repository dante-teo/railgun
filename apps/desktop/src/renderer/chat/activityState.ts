import type { DesktopAgentEvent } from "../../shared/types";

export type ActivityStatus = "running" | "success" | "error" | "interrupted";
export type Todo = NonNullable<Extract<DesktopAgentEvent, { type: "tool-end" }>["todos"]>[number];

export type ActivityEntry =
  | { readonly kind: "tool"; readonly id: string; readonly name: string; readonly status: ActivityStatus; readonly input?: string; readonly output?: string; readonly target?: string; readonly order: number }
  | { readonly kind: "moa-reference"; readonly id: string; readonly index: number; readonly count: number; readonly model: string; readonly status: ActivityStatus; readonly preview?: string; readonly order: number }
  | { readonly kind: "moa-aggregation"; readonly id: string; readonly model: string; readonly refCount: number; readonly status: ActivityStatus; readonly order: number };

export interface AdvisorNote {
  readonly severity: "nit" | "concern" | "blocker";
  readonly text: string;
  readonly order: number;
}

export interface SubagentActivity {
  readonly index: number;
  readonly count: number;
  readonly goal: string;
  readonly status: "running" | "completed" | "interrupted";
  readonly result?: string;
}

export interface ActivityState {
  readonly entries: readonly ActivityEntry[];
  readonly todos: readonly Todo[];
  readonly todoLoading: boolean;
  readonly subagents: readonly SubagentActivity[];
  readonly advisorNotes: readonly AdvisorNote[];
}

export const initialActivityState: ActivityState = { entries: [], todos: [], todoLoading: false, subagents: [], advisorNotes: [] };

type OrderedEvent = Extract<DesktopAgentEvent, { type: "tool-start" | "moa-reference-start" | "moa-aggregating" | "advisor-note" | "subagent-start" }> & { readonly order: number };
export type ActivityAction =
  | OrderedEvent
  | Extract<DesktopAgentEvent, { type: "tool-end" | "moa-reference-end" | "subagent-end" }>
  | { readonly type: "settle"; readonly reason: "interrupted" }
  | { readonly type: "aggregation-complete" }
  | { readonly type: "run-start" }
  | { readonly type: "reset" };

const replaceEntry = (entries: readonly ActivityEntry[], index: number, entry: ActivityEntry): readonly ActivityEntry[] =>
  entries.map((current, candidate) => candidate === index ? entry : current);

const hasRunningTodo = (entries: readonly ActivityEntry[]): boolean =>
  entries.some(entry => entry.kind === "tool" && entry.name === "todo" && entry.status === "running");

export const activityReducer = (state: ActivityState, action: ActivityAction): ActivityState => {
  switch (action.type) {
    case "tool-start":
      if (state.entries.some(entry => entry.kind === "tool" && entry.id === action.id && entry.status === "running")) return state;
      return {
        ...state,
        entries: [...state.entries, { kind: "tool", id: action.id, name: action.name, status: "running", order: action.order, ...(action.input === undefined ? {} : { input: action.input }) }],
        todoLoading: state.todoLoading || action.name === "todo",
      };
    case "tool-end": {
      const index = state.entries.findIndex(entry => entry.kind === "tool" && entry.id === action.id && entry.name === action.name && entry.status === "running");
      if (index < 0) return state;
      const current = state.entries[index]!;
      if (current.kind !== "tool") return state;
      if (action.name === "todo" && !action.failed && action.todos !== undefined) {
        const entries = state.entries.filter((_, candidate) => candidate !== index);
        return { ...state, entries, todos: action.todos, todoLoading: hasRunningTodo(entries) };
      }
      const entries = replaceEntry(state.entries, index, { ...current, status: action.failed ? "error" : "success", ...(action.output === undefined ? {} : { output: action.output }) });
      return {
        ...state,
        entries,
        todoLoading: action.name === "todo" ? hasRunningTodo(entries) : state.todoLoading,
      };
    }
    case "moa-reference-start":
      return { ...state, entries: [...state.entries, { kind: "moa-reference", id: `moa-${action.index}-${action.model}`, index: action.index, count: action.count, model: action.model, status: "running", order: action.order }] };
    case "moa-reference-end": {
      const index = state.entries.findIndex(entry => entry.kind === "moa-reference" && entry.index === action.index && entry.model === action.model && entry.status === "running");
      if (index < 0) return state;
      const current = state.entries[index]!;
      return current.kind === "moa-reference"
        ? { ...state, entries: replaceEntry(state.entries, index, { ...current, status: "success", preview: action.preview }) }
        : state;
    }
    case "moa-aggregating":
      return { ...state, entries: [...state.entries, { kind: "moa-aggregation", id: `moa-aggregation-${action.order}`, model: action.model, refCount: action.refCount, status: "running", order: action.order }] };
    case "advisor-note":
      return { ...state, advisorNotes: [...state.advisorNotes, { severity: action.severity, text: action.text, order: action.order }] };
    case "subagent-start":
      return { ...state, subagents: [...state.subagents.filter(item => item.index !== action.index), { index: action.index, count: action.count, goal: action.goal, status: "running" }] };
    case "subagent-end": {
      const index = state.subagents.findIndex(item => item.index === action.index && item.status === "running");
      return index < 0 ? state : {
        ...state,
        subagents: state.subagents.map((item, candidate) => candidate === index ? { ...item, goal: action.goal, result: action.result, status: "completed" } : item),
      };
    }
    case "aggregation-complete":
      return {
        ...state,
        entries: state.entries.map(entry => entry.kind === "moa-aggregation" && entry.status === "running"
          ? { ...entry, status: "success" }
          : entry),
      };
    case "settle":
      return {
        ...state,
        entries: state.entries.map(entry => entry.status === "running"
          ? { ...entry, status: "interrupted" }
          : entry),
        todoLoading: false,
        subagents: state.subagents.map(item => item.status === "running" ? { ...item, status: "interrupted" } : item),
      };
    case "run-start":
      return { ...state, subagents: [], advisorNotes: [] };
    case "reset": return initialActivityState;
  }
};
