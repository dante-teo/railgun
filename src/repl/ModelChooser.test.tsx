import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import type { DevinModel } from "widevin";
import { ModelRow, modelMetadata, resolveModelCommand } from "./ModelChooser.js";
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

const alpha: DevinModel = {
  id: "alpha-model",
  name: "Alpha",
  provider: "devin",
  baseUrl: "https://example.test",
  input: ["text"],
  supportsTools: true,
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 8_000,
};

const beta: DevinModel = {
  id: "beta-model",
  name: "Beta",
  provider: "devin",
  baseUrl: "https://example.test",
  input: ["text", "image"],
  supportsTools: true,
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 16_000,
};

const testModels: readonly DevinModel[] = [alpha, beta];

describe("resolveModelCommand", () => {
  it("shows current model and numbered list when called with no arg", () => {
    const result = resolveModelCommand(undefined, testModels, "alpha-model");
    expect(result.kind).toBe("show");
    if (result.kind !== "show") throw new Error("unreachable");
    expect(result.lines[0]).toBe("Current model: alpha-model");
    expect(result.lines).toHaveLength(3 + testModels.length);
    expect(result.lines[3]).toContain("1.");
    expect(result.lines[3]).toContain("alpha-model");
    expect(result.lines[4]).toContain("2.");
    expect(result.lines[4]).toContain("beta-model");
    expect(result.sessionOnly).toBe(false);
  });

  it("resolves by exact model id with persist=true", () => {
    const result = resolveModelCommand("beta-model", testModels, "alpha-model");
    expect(result).toEqual({ kind: "switch", model: beta, persist: true });
  });

  it("resolves by 1-based numeric index", () => {
    const result = resolveModelCommand("2", testModels, "alpha-model");
    expect(result).toEqual({ kind: "switch", model: beta, persist: true });
  });

  it("returns error for unknown model name", () => {
    const result = resolveModelCommand("nonexistent", testModels, "alpha-model");
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toContain("nonexistent");
    expect(result.message).toContain("alpha-model");
    expect(result.message).toContain("beta-model");
  });

  it("returns error for out-of-range index", () => {
    const result = resolveModelCommand("99", testModels, "alpha-model");
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toContain("99");
  });

  it("switches with persist=false when --session flag is present", () => {
    const result = resolveModelCommand("beta-model --session", testModels, "alpha-model");
    expect(result).toEqual({ kind: "switch", model: beta, persist: false });
  });

  it("handles --session flag before model name", () => {
    const result = resolveModelCommand("--session beta-model", testModels, "alpha-model");
    expect(result).toEqual({ kind: "switch", model: beta, persist: false });
  });

  it("opens picker with sessionOnly when bare --session is passed", () => {
    const result = resolveModelCommand("--session", testModels, "alpha-model");
    expect(result.kind).toBe("show");
    if (result.kind !== "show") throw new Error("unreachable");
    expect(result.sessionOnly).toBe(true);
  });
});
