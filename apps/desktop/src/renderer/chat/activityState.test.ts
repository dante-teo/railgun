import { describe, expect, it } from "vitest";
import { activityReducer, initialActivityState } from "./activityState";

describe("agent activity reduction", () => {
  it("preserves parallel tool chronology and ignores unmatched or duplicate completions", () => {
    let state = activityReducer(initialActivityState, { type: "tool-start", id: "a", name: "read_file", input: "one", order: 1 });
    state = activityReducer(state, { type: "tool-start", id: "b", name: "run_shell", order: 2 });
    state = activityReducer(state, { type: "tool-end", id: "b", name: "run_shell", failed: true, output: "bad" });
    state = activityReducer(state, { type: "tool-end", id: "missing", name: "x", failed: false });
    const settled = state;
    state = activityReducer(state, { type: "tool-end", id: "b", name: "run_shell", failed: false });
    expect(state).toBe(settled);
    expect(state.entries).toEqual([
      expect.objectContaining({ kind: "tool", id: "a", status: "running", order: 1 }),
      expect.objectContaining({ kind: "tool", id: "b", status: "error", output: "bad", order: 2 }),
    ]);
  });

  it("accepts a reused tool call id after the previous invocation settles", () => {
    let state = activityReducer(initialActivityState, { type: "tool-start", id: "reused", name: "read_file", order: 1 });
    state = activityReducer(state, { type: "tool-end", id: "reused", name: "read_file", failed: false });
    state = activityReducer(state, { type: "tool-start", id: "reused", name: "read_file", order: 2 });
    state = activityReducer(state, { type: "tool-end", id: "reused", name: "read_file", failed: true });
    expect(state.entries).toEqual([
      expect.objectContaining({ id: "reused", order: 1, status: "success" }),
      expect.objectContaining({ id: "reused", order: 2, status: "error" }),
    ]);
  });

  it("replaces todos on successful completion, removes its tool row, and retains failures", () => {
    let state = activityReducer(initialActivityState, { type: "tool-start", id: "todo-1", name: "todo", order: 1 });
    expect(state.todoLoading).toBe(true);
    state = activityReducer(state, { type: "tool-end", id: "todo-1", name: "todo", failed: false, todos: [{ id: "a", content: "A", status: "completed" }] });
    expect(state.entries).toEqual([]);
    expect(state.todos).toEqual([{ id: "a", content: "A", status: "completed" }]);
    expect(state.todoLoading).toBe(false);
    state = activityReducer(state, { type: "tool-start", id: "todo-2", name: "todo", order: 2 });
    state = activityReducer(state, { type: "tool-end", id: "todo-2", name: "todo", failed: true, output: "invalid" });
    expect(state.entries).toEqual([expect.objectContaining({ id: "todo-2", status: "error" })]);
  });

  it("keeps parallel todos loading and ignores a mismatched completion name", () => {
    let state = activityReducer(initialActivityState, { type: "tool-start", id: "todo-1", name: "todo", order: 1 });
    state = activityReducer(state, { type: "tool-start", id: "todo-2", name: "todo", order: 2 });
    const beforeMismatch = state;
    state = activityReducer(state, { type: "tool-end", id: "todo-1", name: "read_file", failed: false });
    expect(state).toBe(beforeMismatch);
    state = activityReducer(state, { type: "tool-end", id: "todo-1", name: "todo", failed: false, todos: [] });
    expect(state.todoLoading).toBe(true);
    state = activityReducer(state, { type: "tool-end", id: "todo-2", name: "todo", failed: false, todos: [] });
    expect(state.todoLoading).toBe(false);
  });

  it("correlates MoA references and appends aggregation and advisor rows", () => {
    let state = activityReducer(initialActivityState, { type: "moa-reference-start", index: 0, count: 1, model: "ref", order: 1 });
    state = activityReducer(state, { type: "moa-reference-end", index: 0, model: "ref", preview: "answer" });
    state = activityReducer(state, { type: "moa-aggregating", model: "agg", refCount: 1, order: 2 });
    state = activityReducer(state, { type: "aggregation-complete" });
    state = activityReducer(state, { type: "advisor-note", severity: "concern", text: "Check", order: 3 });
    expect(state.entries).toEqual([
      expect.objectContaining({ kind: "moa-reference", status: "success", preview: "answer", order: 1 }),
      expect.objectContaining({ kind: "moa-aggregation", model: "agg", status: "success", order: 2 }),
      expect.objectContaining({ kind: "advisor", severity: "concern", order: 3 }),
    ]);
  });

  it("tracks current-run subagents and settles running work on end, cancellation, and disconnect", () => {
    let state = activityReducer(initialActivityState, { type: "subagent-start", index: 0, count: 1, goal: "Inspect", order: 1 });
    state = activityReducer(state, { type: "tool-start", id: "a", name: "read_file", order: 2 });
    state = activityReducer(state, { type: "settle", reason: "interrupted" });
    expect(state.subagents).toEqual([expect.objectContaining({ status: "interrupted" })]);
    expect(state.entries).toEqual([expect.objectContaining({ status: "interrupted" })]);
    state = activityReducer(state, { type: "run-start" });
    expect(state.subagents).toEqual([]);
    state = activityReducer(state, { type: "reset" });
    expect(state).toBe(initialActivityState);
  });
});
