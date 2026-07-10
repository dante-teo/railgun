import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import type { DevinModel } from "widevin";
import { ModelRow, modelMetadata } from "./ModelChooser.js";
import {
  createSelectionInputState,
  moveSelection,
  reduceSelectionInput,
  selectionListWindow,
} from "./SessionChooser.js";
import { THEMES } from "./theme.js";

const model: DevinModel = {
  id: "model-id",
  name: "Model Name",
  provider: "devin",
  baseUrl: "https://example.test",
  input: ["text", "image"],
  supportsTools: true,
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 16_000,
};

describe("shared chooser mechanics", () => {
  it("wraps Up/Down navigation and maintains resize-aware windows", () => {
    expect(moveSelection(0, 3, "up")).toBe(2);
    expect(moveSelection(2, 3, "down")).toBe(0);
    expect(selectionListWindow(5, 10, 3)).toEqual({ start: 3, end: 6 });
    expect(selectionListWindow(5, 10, 1)).toEqual({ start: 5, end: 6 });
  });

  it("handles Enter selection and Escape/Ctrl-C cancellation", () => {
    expect(reduceSelectionInput(1, 3, "", { return: true })).toEqual({ type: "finish", index: 1 });
    expect(reduceSelectionInput(1, 3, "", { escape: true })).toEqual({ type: "cancel" });
    expect(reduceSelectionInput(1, 3, "c", { ctrl: true })).toEqual({ type: "cancel" });
  });

  it("applies rapid navigation before Enter without waiting for a render", () => {
    const state = createSelectionInputState();

    expect(state.reduce(3, "", { downArrow: true })).toEqual({ type: "move", index: 1 });
    expect(state.reduce(3, "", { downArrow: true })).toEqual({ type: "move", index: 2 });
    expect(state.reduce(3, "", { return: true })).toEqual({ type: "finish", index: 2 });
  });
});

describe("ModelRow", () => {
  it("renders the model name first and useful ID/capability metadata second", () => {
    const rendered = renderToString(<ModelRow model={model} selected={true} theme={THEMES.dark} columns={100} />);
    expect(rendered.indexOf("Model Name")).toBeLessThan(rendered.indexOf("model-id"));
    expect(rendered).toContain("images");
    expect(rendered).toContain("reasoning");
    expect(rendered).toContain("200k context");
    expect(modelMetadata(model)).toContain("16k output");
  });
});
