import { describe, expect, it, vi } from "vitest";
import { createInteractionBroker } from "./interactionBroker";
import { DESKTOP_INTERACTION_LIMITS } from "../shared/schemas";

const approval = { type: "approval_request", requestId: "backend-approval", command: "Bearer sk-secret-token run" };
const clarification = { type: "clarification_request", requestId: "backend-clarification", question: "Which path?", choices: ["Fast", "Safe"] };

describe("desktop interaction broker", () => {
  it("redacts and correlates backend requests without exposing backend IDs", async () => {
    const call = vi.fn(async () => undefined);
    const emit = vi.fn();
    const broker = createInteractionBroker({ call, emit, randomId: () => "11111111-1111-4111-8111-111111111111" });

    const request = broker.receiveBackendEvent(approval);
    expect(request).toEqual({ type: "approval", id: "11111111-1111-4111-8111-111111111111", command: "Bearer [REDACTED] run" });
    expect(JSON.stringify(request)).not.toContain("backend-approval");
    expect(emit).toHaveBeenCalledWith(request);

    await broker.respondToApproval(request!.id, true);
    expect(call).toHaveBeenCalledWith(
      { type: "approval_response", requestId: "backend-approval", approved: true },
      expect.any(Function),
    );
    expect(broker.pendingCount()).toBe(0);
  });

  it("supports choices, rejects malformed or duplicate requests, and prevents mismatched responses", async () => {
    const call = vi.fn(async () => undefined);
    const broker = createInteractionBroker({ call, emit: vi.fn(), randomId: () => "22222222-2222-4222-8222-222222222222" });
    const request = broker.receiveBackendEvent(clarification);

    expect(request).toMatchObject({ type: "clarification", question: "Which path?", choices: ["Fast", "Safe"] });
    expect(broker.receiveBackendEvent(clarification)).toBeUndefined();
    expect(broker.receiveBackendEvent({ ...clarification, requestId: "" })).toBeUndefined();
    expect(broker.receiveBackendEvent({ ...clarification, requestId: "oversized", question: "x".repeat(8_001) })).toBeUndefined();
    await expect(broker.respondToApproval(request!.id, true)).rejects.toThrow(/not an approval/u);
    await broker.respondToClarification(request!.id, "Fast");
    await expect(broker.respondToClarification(request!.id, "Safe")).rejects.toThrow(/already settled/u);
  });

  it("retains a prompt for retry after a response error and clears stale mappings on settlement", async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error("backend disconnected")).mockResolvedValueOnce(undefined);
    const broker = createInteractionBroker({ call, emit: vi.fn(), randomId: () => "33333333-3333-4333-8333-333333333333" });
    const request = broker.receiveBackendEvent(approval)!;

    await expect(broker.respondToApproval(request.id, false)).rejects.toThrow("backend disconnected");
    expect(broker.pendingCount()).toBe(1);
    await broker.respondToApproval(request.id, false);
    expect(broker.pendingCount()).toBe(0);

    broker.receiveBackendEvent(approval);
    expect(broker.pendingCount()).toBe(1);
    broker.receiveBackendEvent({ type: "agent_end" });
    expect(broker.pendingCount()).toBe(0);
    await expect(broker.respondToApproval(request.id, true)).rejects.toThrow(/already settled/u);
  });

  it("bounds redacted text and settles invalid requests instead of throwing or hanging", () => {
    const call = vi.fn(async () => undefined);
    const emit = vi.fn();
    const broker = createInteractionBroker({ call, emit, randomId: () => "44444444-4444-4444-8444-444444444444" });
    const command = `${"x".repeat(DESKTOP_INTERACTION_LIMITS.command - "DEVIN_TOKEN=x".length)}DEVIN_TOKEN=x`;

    expect(() => broker.receiveBackendEvent({ type: "approval_request", requestId: "boundary", command })).not.toThrow();
    expect(emit.mock.calls[0]?.[0].command.length).toBeLessThanOrEqual(DESKTOP_INTERACTION_LIMITS.command);

    broker.receiveBackendEvent({ type: "clarification_request", requestId: "invalid-question", question: "x".repeat(DESKTOP_INTERACTION_LIMITS.question + 1) });
    expect(call).toHaveBeenCalledWith(
      { type: "clarification_response", requestId: "invalid-question", answer: "[user declined to answer]" },
      expect.any(Function),
    );
    broker.receiveBackendEvent({ type: "clarification_request", question: "missing id" });
    expect(call).toHaveBeenCalledWith({ type: "abort" }, expect.any(Function));
  });
});
