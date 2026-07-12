import { describe, expect, it, vi } from "vitest";
import type React from "react";
import type { DevinMessage } from "widevin";
import {
  TodoPanel,
  TranscriptRowLine,
  displayLineToTranscriptRows,
  attemptCheckpoint,
  createHydratedTodoStore,
  historyToDisplayLines,
  parseAdvisoryMessage,
  shouldAppendToolTranscriptLine,
  shouldShowToolLine,
  transcriptJustification,
} from "./App.js";
import { createTodoStore } from "../tools/todo.js";
import { THEMES } from "./theme.js";

describe("TodoPanel", () => {
  it("hides when todo state is empty", () => {
    expect(TodoPanel({ todos: [], isLoading: false, theme: THEMES.dark })).toBeNull();
  });

  it("renders when todo state is nonempty", () => {
    const store = createTodoStore([{ id: "a", content: "A", status: "pending" }]);
    const panel = TodoPanel({ todos: store.read(), isLoading: false, theme: THEMES.dark });
    const element = panel as React.ReactElement<{ children: readonly React.ReactElement[] }>;
    const header = element.props.children[0] as React.ReactElement<{ children: readonly unknown[] }>;

    expect(panel).not.toBeNull();
    expect(header.props.children).toEqual(["Todos · ", 0, "/", 1]);
  });

  it("renders a loading state while todos are being crafted", () => {
    const panel = TodoPanel({ todos: [], isLoading: true, theme: THEMES.dark });
    const element = panel as React.ReactElement<{ children: readonly React.ReactElement[] }>;
    const loading = element.props.children[1] as React.ReactElement<{ children: readonly unknown[] }>;

    expect(panel).not.toBeNull();
    expect(loading.props.children).toContain(" Crafting todos");
  });

  it("suppresses normal transcript lines for todo completions", () => {
    expect(shouldAppendToolTranscriptLine("todo")).toBe(false);
    expect(shouldAppendToolTranscriptLine("read_file")).toBe(true);
  });

  it("surfaces todo tool errors even though successful completions are suppressed", () => {
    expect(shouldShowToolLine("todo", false)).toBe(false);
    expect(shouldShowToolLine("todo", true)).toBe(true);
    expect(shouldShowToolLine("read_file", false)).toBe(true);
    expect(shouldShowToolLine("read_file", true)).toBe(true);
  });

  it("renders pending items with [ ] glyph", () => {
    const store = createTodoStore([{ id: "a", content: "A", status: "pending" }]);
    const panel = TodoPanel({ todos: store.read(), isLoading: false, theme: THEMES.dark });
    const element = panel as unknown as React.ReactElement<{ children: readonly unknown[] }>;
    const items = element.props.children[2] as unknown as React.ReactElement[];
    const glyphText = (items[0] as React.ReactElement<{ children: readonly unknown[] }>).props.children[0] as React.ReactElement<{ children: readonly unknown[] }>;

    expect(glyphText.props.children).toContain("[ ]");
  });

  it("renders completed items with [x] glyph", () => {
    const store = createTodoStore([{ id: "a", content: "A", status: "completed" }]);
    const panel = TodoPanel({ todos: store.read(), isLoading: false, theme: THEMES.dark });
    const element = panel as unknown as React.ReactElement<{ children: readonly unknown[] }>;
    const items = element.props.children[2] as unknown as React.ReactElement[];
    const glyphText = (items[0] as React.ReactElement<{ children: readonly unknown[] }>).props.children[0] as React.ReactElement<{ children: readonly unknown[] }>;

    expect(glyphText.props.children).toContain("[x]");
  });
});

describe("TranscriptLine", () => {
  it("keeps short transcript slices adjacent to the composer without moving full pages", () => {
    expect(transcriptJustification(2, false, 10)).toBe("flex-end");
    expect(transcriptJustification(9, true, 10)).toBe("flex-start");
    expect(transcriptJustification(10, false, 10)).toBe("flex-start");
  });

  it("uses the same fixed role gutter for user and assistant bodies", () => {
    const userRow = displayLineToTranscriptRows({ kind: "user", text: "hello" }, THEMES.light, 80)[0]!;
    const assistantRow = displayLineToTranscriptRows({ kind: "assistant", text: "hello" }, THEMES.light, 80)[0]!;
    type RowElement = React.ReactElement<{ children: readonly React.ReactElement<{ width?: number }>[] }>;
    const user = TranscriptRowLine({ row: userRow, theme: THEMES.light }) as RowElement;
    const assistant = TranscriptRowLine({ row: assistantRow, theme: THEMES.light }) as RowElement;
    const userChildren = user.props.children;
    const assistantChildren = assistant.props.children;

    expect(userChildren[0]?.props.width).toBe(10);
    expect(assistantChildren[0]?.props.width).toBe(10);
  });

  it("counts every physical wrapped row so long model output is not clipped", () => {
    const rows = displayLineToTranscriptRows(
      { kind: "assistant", text: "one two three four five six seven eight nine ten" },
      THEMES.light,
      18,
    );

    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map(row => row.text).join(" ")).toContain("ten");
  });
});

describe("persistent REPL hydration", () => {
  it("parses advisor envelopes without displaying raw XML", () => {
    expect(parseAdvisoryMessage('<advisory severity="concern" guidance="weigh, don\'t blindly obey">\nCheck &lt;this&gt; &amp; that.\n</advisory>')).toEqual({
      severity: "concern",
      text: "Check <this> & that.",
    });
    expect(parseAdvisoryMessage("ordinary user text")).toBeNull();
  });

  it("classifies persisted advisory messages separately from user turns", () => {
    const history: readonly DevinMessage[] = [
      { role: "user", content: "Question" },
      { role: "assistant", content: [{ type: "text", text: "Answer" }] },
      { role: "user", content: '<advisory severity="blocker" guidance="weigh">\nUnsafe change\n</advisory>' },
      { role: "assistant", content: [{ type: "text", text: "Corrected" }] },
    ];

    expect(historyToDisplayLines(history)).toEqual([
      { kind: "user", text: "Question" },
      { kind: "assistant", text: "Answer" },
      { kind: "advisory", severity: "blocker", text: "Unsafe change" },
      { kind: "assistant", text: "Corrected" },
    ]);
  });

  it("groups historical assistant text with each user turn and omits tool frames", () => {
    const history: readonly DevinMessage[] = [
      { role: "user", content: "Find it" },
      { role: "assistant", content: [{ type: "text", text: "Looking. " }, { type: "toolCall", id: "c1", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "c1", content: "secret", isError: false },
      { role: "assistant", content: [{ type: "thinking", thinking: "done" }, { type: "text", text: "Found it." }] },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
      { role: "assistant", content: [{ type: "text", text: "Welcome." }] },
    ];

    expect(historyToDisplayLines(history)).toEqual([
      { kind: "user", text: "Find it" },
      { kind: "assistant", text: "Looking. Found it." },
      { kind: "user", text: "Thanks" },
      { kind: "assistant", text: "Welcome." },
    ]);
  });

  it("hydrates todos and can restore the pre-turn snapshot after a failed turn", () => {
    const initial = [{ id: "a", content: "Original", status: "pending" }] as const;
    let store = createHydratedTodoStore(initial);
    store.write({ todos: [{ id: "b", content: "Side effect", status: "completed" }] });

    store = createHydratedTodoStore(initial);
    expect(store.read()).toEqual(initial);
  });

  it("marks save failures unsaved, retries the complete in-memory snapshot, and clears on recovery", () => {
    const firstHistory = [{ role: "user", content: "one" }, { role: "assistant", content: [{ type: "text", text: "first" }] }] satisfies DevinMessage[];
    const recoveredHistory = [...firstHistory, { role: "user", content: "two" }, { role: "assistant", content: [{ type: "text", text: "second" }] }] satisfies DevinMessage[];
    const checkpoint = vi.fn()
      .mockImplementationOnce(() => { throw new Error("disk full"); })
      .mockImplementationOnce(() => {});

    const failed = attemptCheckpoint(checkpoint, firstHistory, [], false);
    const recovered = attemptCheckpoint(checkpoint, recoveredHistory, [], failed.unsaved);

    expect(failed).toMatchObject({ unsaved: true, recovered: false, error: "disk full" });
    expect(recovered).toEqual({ unsaved: false, recovered: true });
    expect(checkpoint).toHaveBeenLastCalledWith(recoveredHistory, []);
  });
});
