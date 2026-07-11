import { describe, it } from "vitest";
import type { RpcCommand, RpcResponse, RpcErrorResponse, RpcSessionState, RpcSuccessResponse } from "./types.js";

// Type-level smoke tests — verify the discriminated union shapes compile.
// No runtime logic; the test file simply needs to compile without errors.

describe("types", () => {
  it("RpcCommand union members are distinct and assignable", () => {
    const prompt = { type: "prompt", message: "hello" } satisfies RpcCommand;
    const steer = { type: "steer", message: "nudge" } satisfies RpcCommand;
    const followUp = { type: "follow_up", message: "next" } satisfies RpcCommand;
    const abort = { type: "abort" } satisfies RpcCommand;
    const getState = { type: "get_state" } satisfies RpcCommand;
    const getMessages = { type: "get_messages" } satisfies RpcCommand;
    const setModel = { type: "set_model", modelId: "claude-4" } satisfies RpcCommand;
    const getModels = { type: "get_available_models" } satisfies RpcCommand;
    const compact = { type: "compact" } satisfies RpcCommand;
    const setAutoCompaction = { type: "set_auto_compaction", enabled: true } satisfies RpcCommand;

    // All can carry an optional id
    const withId = { id: "1", type: "abort" } satisfies RpcCommand;

    // Confirm these are all just objects (runtime proof of compile success)
    const all = [prompt, steer, followUp, abort, getState, getMessages, setModel, getModels, compact, setAutoCompaction, withId];
    if (all.length === 0) throw new Error("unreachable");
  });

  it("RpcSuccessResponse members have correct command discriminant", () => {
    const promptResp = { type: "response", command: "prompt", success: true } satisfies RpcSuccessResponse;
    const stateResp = { type: "response", command: "get_state", success: true, data: { running: false, model: "m", messageCount: 0, todos: [] } } satisfies RpcSuccessResponse;
    const all = [promptResp, stateResp];
    if (all.length === 0) throw new Error("unreachable");
  });

  it("RpcErrorResponse has success: false and error string", () => {
    const err = { type: "response", command: "prompt", success: false, error: "oops" } satisfies RpcErrorResponse;
    if (!err) throw new Error("unreachable");
  });

  it("RpcSessionState is structurally correct", () => {
    const state: RpcSessionState = { running: false, model: "m", messageCount: 0, todos: [] };
    if (!state) throw new Error("unreachable");
  });

  it("RpcResponse accepts both success and error variants", () => {
    const ok: RpcResponse = { type: "response", command: "abort", success: true };
    const err: RpcResponse = { type: "response", command: "abort", success: false, error: "not running" };
    const all = [ok, err];
    if (all.length === 0) throw new Error("unreachable");
  });
});
