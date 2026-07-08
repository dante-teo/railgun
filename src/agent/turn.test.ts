import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevinProvider, DevinStreamEvent } from "widevin";
import { runTurn } from "./turn.js";

type FakeRound = readonly DevinStreamEvent[] | { throws: unknown };

const approveAll = async () => true;

const fakeProvider = (rounds: readonly FakeRound[]): DevinProvider => {
  let callIndex = 0;
  return {
    login: vi.fn(),
    setToken: vi.fn(),
    clearToken: vi.fn(),
    listModels: vi.fn(),
    streamChat: async function* () {
      const round = rounds[callIndex++];
      if (!round) throw new Error(`streamChat called more times (call ${callIndex}) than scripted (${rounds.length})`);
      if ("throws" in round) throw round.throws;
      for (const event of round) yield event;
    }
  };
};

describe("runTurn", () => {
  it("accumulates text_delta events, streams via onDelta, and appends user+assistant messages", async () => {
    const devin = fakeProvider([
      [
        { type: "text_delta", delta: "Hel" },
        { type: "text_delta", delta: "lo" },
        { type: "done", reason: "stop" }
      ]
    ]);
    const deltas: string[] = [];

    const outcome = await runTurn(devin, "model-1", [], "Hi", approveAll, d => deltas.push(d));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.assistantText).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(outcome.messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello" }] }
    ]);
  });

  it("keeps prior history intact and appends the new turn on success", async () => {
    const devin = fakeProvider([[{ type: "text_delta", delta: "Alex" }]]);
    const priorHistory = [
      { role: "user", content: "My name is Alex" },
      { role: "assistant", content: [{ type: "text", text: "Nice to meet you, Alex" }] }
    ] as const;

    const outcome = await runTurn(devin, "model-1", priorHistory, "What is my name?", approveAll);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.messages.slice(0, 2)).toEqual(priorHistory);
    expect(outcome.messages).toHaveLength(4);
  });

  it("returns ok:false and leaves the caller's history untouched when streamChat throws", async () => {
    const boom = new Error("network blip");
    const devin = fakeProvider([{ throws: boom }]);

    const outcome = await runTurn(devin, "model-1", [], "Hi", approveAll);

    expect(outcome).toEqual({ ok: false, error: boom });
  });

  describe("tool calling", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "railgun-turn-test-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("round-trips a successful read_file tool call into the final answer (proves registry wiring works end-to-end)", async () => {
      const filePath = join(dir, "secret.txt");
      await writeFile(filePath, "the secret is 42", "utf-8");

      const devin = fakeProvider([
        [{ type: "toolcall_end", id: "call-1", name: "read_file", arguments: { path: filePath } }],
        [{ type: "text_delta", delta: "The secret is 42." }]
      ]);

      const outcome = await runTurn(devin, "model-1", [], "What is the secret?", approveAll);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.assistantText).toBe("The secret is 42.");
      expect(outcome.messages).toEqual([
        { role: "user", content: "What is the secret?" },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: filePath } }]
        },
        { role: "tool", toolCallId: "call-1", content: "the secret is 42", isError: false },
        { role: "assistant", content: [{ type: "text", text: "The secret is 42." }] }
      ]);
    });

    it("passes confirmShellCommand through to a run_shell_command tool call", async () => {
      const devin = fakeProvider([
        [{ type: "toolcall_end", id: "call-1", name: "run_shell_command", arguments: { command: "echo turn-test" } }],
        [{ type: "text_delta", delta: "Ran it." }]
      ]);
      const confirmShellCommand = vi.fn(async () => true);

      const outcome = await runTurn(devin, "model-1", [], "Run echo turn-test", confirmShellCommand);

      expect(confirmShellCommand).toHaveBeenCalledWith("echo turn-test");
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      const toolMessage = outcome.messages.find(m => m.role === "tool");
      expect(toolMessage).toBeDefined();
      if (!toolMessage || toolMessage.role !== "tool") throw new Error("expected tool message");
      expect(toolMessage.isError).toBe(false);
    });

    it("stops after MAX_STEPS rounds and reports the step-limit sentinel", async () => {
      const rounds: FakeRound[] = Array.from({ length: 10 }, (_, i) => [
        { type: "toolcall_end", id: `call-${i}`, name: "loop_forever", arguments: {} }
      ]);
      const devin = fakeProvider(rounds);
      const streamChatSpy = vi.spyOn(devin, "streamChat");

      const outcome = await runTurn(devin, "model-1", [], "Loop forever", approveAll);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.assistantText).toBe("(stopped: too many steps)");
      expect(streamChatSpy).toHaveBeenCalledTimes(10);
    });

    it("discards the whole turn and leaves caller history untouched when a later round throws", async () => {
      const filePath = join(dir, "secret.txt");
      await writeFile(filePath, "the secret is 42", "utf-8");
      const boom = new Error("network blip");

      const devin = fakeProvider([
        [{ type: "toolcall_end", id: "call-1", name: "read_file", arguments: { path: filePath } }],
        { throws: boom }
      ]);
      const priorHistory = [{ role: "user", content: "hi" }] as const;
      const priorHistorySnapshot = JSON.parse(JSON.stringify(priorHistory));

      const outcome = await runTurn(devin, "model-1", priorHistory, "What is the secret?", approveAll);

      expect(outcome).toEqual({ ok: false, error: boom });
      expect(priorHistory).toEqual(priorHistorySnapshot);
    });
  });
});
