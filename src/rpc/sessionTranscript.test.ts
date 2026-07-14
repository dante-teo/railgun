import { describe, expect, it } from "vitest";
import { createRpcTranscriptPage } from "./sessionTranscript.js";

describe("RPC session transcript", () => {
  it("projects only textual user and assistant content", () => {
    const page = createRpcTranscriptPage("saved", [
      { role: "user", content: [{ type: "image", data: "private" }, { type: "text", text: "Visible user" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "private", thinkingSignature: "secret" },
        { type: "toolCall", id: "call", name: "shell", arguments: { token: "must-not-cross" } },
        { type: "text", text: "Visible assistant" },
      ] },
      { role: "tool", toolCallId: "call", content: "private result" },
    ]);

    expect(page).toEqual({
      sessionId: "saved",
      messages: [
        { role: "user", text: "Visible user" },
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
    expect(page.messages.every(message => Buffer.byteLength(message.text, "utf8") <= 24 * 1024)).toBe(true);
  });
});
