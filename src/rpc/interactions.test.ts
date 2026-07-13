import { describe, expect, it } from "vitest";
import { createRpcInteractions } from "./interactions.js";
import type { RpcInteractionRequest } from "./types.js";

describe("createRpcInteractions", () => {
  it("correlates concurrent approvals and rejects duplicate or mismatched responses", async () => {
    const events: RpcInteractionRequest[] = [];
    const ids = ["approval-1", "approval-2"];
    const interactions = createRpcInteractions(event => events.push(event), { randomId: () => ids.shift()! });
    const first = interactions.requestApproval("sudo one");
    const second = interactions.requestApproval("sudo two");

    interactions.resolveApproval("approval-2", false);
    interactions.resolveApproval("approval-1", true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(events.map(event => event.requestId)).toEqual(["approval-1", "approval-2"]);
    expect(() => interactions.resolveApproval("approval-1", true)).toThrow(/unknown or already resolved/);
  });

  it("rejects every pending request on shutdown", async () => {
    const ids = ["approval", "clarification"];
    const interactions = createRpcInteractions(() => {}, { randomId: () => ids.shift()! });
    const approval = interactions.requestApproval("sudo one");
    const clarification = interactions.requestClarification("Which one?");
    interactions.rejectAll("connection closed");
    await expect(approval).rejects.toThrow("connection closed");
    await expect(clarification).rejects.toThrow("connection closed");
  });
});
