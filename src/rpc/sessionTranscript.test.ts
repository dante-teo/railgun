import { describe, expect, it } from "vitest";
import { createRpcTranscriptPage } from "./sessionTranscript.js";

describe("RPC session transcript", () => {
  it("projects textual conversation and safe tool activity without raw payloads", () => {
    const page = createRpcTranscriptPage("saved", [
      { role: "user", content: [{ type: "image", data: "private" }, { type: "text", text: "Visible user" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "private", thinkingSignature: "secret" },
        { type: "toolCall", id: "call", name: "shell", arguments: { token: "must-not-cross" } },
      ] },
      { role: "tool", toolCallId: "call", content: "private result" },
      { role: "assistant", content: [{ type: "text", text: "Visible assistant" }] },
    ]);

    expect(page).toEqual({
      sessionId: "saved",
      messages: [
        { role: "user", text: "Visible user" },
        { role: "tool", id: "restored-tool-1-1", name: "shell", failed: false },
        { role: "assistant", text: "Visible assistant" },
      ],
    });
    expect(JSON.stringify(page)).not.toMatch(/must-not-cross|private result|thinkingSignature/u);
  });

  it("keeps every page below the desktop frame limit even with huge provider payloads", () => {
    const history = Array.from({ length: 20 }, (_, index) => index % 2 === 0
      ? { role: "assistant", content: [{ type: "toolCall", arguments: { secret: "x".repeat(100_000) } }, { type: "text", text: "🙂".repeat(40_000) }] }
      : { role: "tool", content: "y".repeat(100_000) });
    const page = createRpcTranscriptPage("saved", history);

    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(49 * 1024);
    expect(page.nextCursor).toBeGreaterThan(0);
    expect(page.messages.every(message => message.role === "tool" || Buffer.byteLength(message.text, "utf8") <= 24 * 1024)).toBe(true);
  });

  it("aligns persistence IDs before filtering hidden provider messages", () => {
    const page = createRpcTranscriptPage("saved", [
      { role: "user", content: "One" },
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
      { role: "tool", toolCallId: "call", content: "private" },
      { role: "assistant", content: [{ type: "text", text: "Two" }] },
    ], 0, 100, [41, 42, 43, 44]);

    expect(page.messages).toEqual([
      { role: "user", text: "One", messageId: 41 },
      { role: "tool", id: "restored-tool-1-0", name: "read", failed: false },
      { role: "assistant", text: "Two", messageId: 44, branchable: true },
    ]);
  });

  it("marks only complete assistant boundaries as branchable", () => {
    const page = createRpcTranscriptPage("saved", [
      { role: "user", content: "Question" },
      { role: "assistant", content: [{ type: "text", text: "Working" }, { type: "toolCall", id: "call", name: "read", arguments: {} }] },
      { role: "tool", toolCallId: "call", content: "result" },
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
    ], 0, 100, [1, 2, 3, 4]);

    expect(page.messages).toEqual([
      { role: "user", text: "Question", messageId: 1 },
      { role: "assistant", text: "Working", messageId: 2 },
      { role: "tool", id: "restored-tool-1-1", name: "read", failed: false },
      { role: "assistant", text: "Done", messageId: 4, branchable: true },
    ]);
  });

  it("projects file targets from mixed and parallel tool calls without exposing raw payloads", () => {
    const page = createRpcTranscriptPage("saved", [
      { role: "user", content: "Inspect the sync flow" },
      { role: "assistant", content: [
        { type: "text", text: "I found the relevant files." },
        { type: "toolCall", id: "read", name: "read_file", arguments: { path: "/private/secret-directory/private.ts" } },
        { type: "toolCall", id: "test", name: "run_shell_command", arguments: { command: "private command" } },
      ] },
      { role: "tool", toolCallId: "read", content: "private file contents", isError: false },
      { role: "tool", toolCallId: "test", content: "private test output", isError: true },
      { role: "assistant", content: [{ type: "text", text: "The retry loop is fixed." }] },
    ], 0, 2, [10, 11, 12, 13, 14]);

    expect(page.messages).toEqual([
      { role: "user", text: "Inspect the sync flow", messageId: 10 },
      { role: "assistant", text: "I found the relevant files.", messageId: 11 },
    ]);
    expect(page.nextCursor).toBe(2);

    const secondPage = createRpcTranscriptPage("saved", [
      { role: "user", content: "Inspect the sync flow" },
      { role: "assistant", content: [
        { type: "text", text: "I found the relevant files." },
        { type: "toolCall", id: "read", name: "read_file", arguments: { path: "/private/secret-directory/private.ts" } },
        { type: "toolCall", id: "test", name: "run_shell_command", arguments: { command: "private command" } },
      ] },
      { role: "tool", toolCallId: "read", content: "private file contents", isError: false },
      { role: "tool", toolCallId: "test", content: "private test output", isError: true },
      { role: "assistant", content: [{ type: "text", text: "The retry loop is fixed." }] },
    ], page.nextCursor, 3, [10, 11, 12, 13, 14]);

    expect(secondPage.messages).toEqual([
      { role: "tool", id: "restored-tool-1-1", name: "read_file", failed: false, target: "private.ts" },
      { role: "tool", id: "restored-tool-1-2", name: "run_shell_command", failed: true },
      { role: "assistant", text: "The retry loop is fixed.", messageId: 14, branchable: true },
    ]);
    expect(JSON.stringify(secondPage)).not.toMatch(/secret-directory|private command|private file contents|private test output/u);
  });

  it("normalizes tool names before deriving their safe file targets", () => {
    const page = createRpcTranscriptPage("saved", [
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "  read_file  ", arguments: { path: "src/cli.ts" } }] },
      { role: "tool", toolCallId: "call", content: "private" },
    ]);

    expect(page.messages).toEqual([
      { role: "tool", id: "restored-tool-0-0", name: "read_file", failed: false, target: "cli.ts" },
    ]);
  });
});
