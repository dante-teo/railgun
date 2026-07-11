import { describe, expect, it } from "vitest";
import { registry } from "./registry.js";
import type { ToolContext } from "./registry.js";
import "./clarify.js";

const makeContext = (clarifyCallback?: ToolContext["clarifyCallback"]): ToolContext => ({
  signal: new AbortController().signal,
  confirmShellCommand: async () => {
    throw new Error("clarify must not request shell approval");
  },
  ...(clarifyCallback !== undefined ? { clarifyCallback } : {}),
});

describe("clarify", () => {
  it("returns an error when question arg is missing", async () => {
    const result = await registry.run("clarify", {}, makeContext());

    expect(result).toEqual({
      content: 'Error: clarify requires a string "question" argument',
      isError: true,
    });
  });

  it("returns an error when clarifyCallback is not present on context", async () => {
    const result = await registry.run("clarify", { question: "Which file?" }, makeContext());

    expect(result).toEqual({
      content: "Error: clarify is not available in this context",
      isError: true,
    });
  });

  it("calls the callback with question only and returns JSON { question, answer }", async () => {
    const callback = async (question: string, choices?: string[]): Promise<string> => {
      expect(choices).toBeUndefined();
      return "the answer";
    };
    const result = await registry.run("clarify", { question: "What color?" }, makeContext(callback));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ question: "What color?", answer: "the answer" });
  });

  it("calls the callback with question and choices and returns JSON { question, answer }", async () => {
    const callback = async (_question: string, choices?: string[]): Promise<string> => {
      expect(choices).toEqual(["red", "blue"]);
      return "blue";
    };
    const result = await registry.run("clarify", { question: "Pick a color", choices: ["red", "blue"] }, makeContext(callback));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ question: "Pick a color", answer: "blue" });
  });

  it("truncates choices to max 4", async () => {
    const callback = async (_question: string, choices?: string[]): Promise<string> => {
      expect(choices).toHaveLength(4);
      expect(choices).toEqual(["a", "b", "c", "d"]);
      return "a";
    };
    const result = await registry.run("clarify", { question: "Pick one", choices: ["a", "b", "c", "d", "e"] }, makeContext(callback));

    expect(result.isError).toBe(false);
  });

  it("returns stopped message when signal is aborted before the call", async () => {
    const controller = new AbortController();
    controller.abort();
    const context: ToolContext = {
      signal: controller.signal,
      confirmShellCommand: async () => false,
      clarifyCallback: async () => "never called",
    };

    const result = await registry.run("clarify", { question: "Anything?" }, context);

    expect(result).toEqual({ content: "[stopped by user]", isError: true });
  });
});
