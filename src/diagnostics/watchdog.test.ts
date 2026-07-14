import { describe, expect, it } from "vitest";
import { createWatchdogState, evaluateWatchdog, noteHeartbeat, noteProgress } from "./watchdog.js";

describe("interactive diagnostics watchdog", () => {
  it("reports event-loop and operation stalls, repeats, then recovers once", () => {
    const initial = createWatchdogState(0);
    const eventLoop = evaluateWatchdog(initial, 10_000);
    expect(eventLoop.events.map(event => event.event)).toEqual(["event_loop_stall"]);
    expect(evaluateWatchdog(eventLoop.state, 39_999).events).toEqual([]);
    expect(evaluateWatchdog(eventLoop.state, 40_000).events.map(event => event.event)).toEqual(["event_loop_stall"]);

    const heartbeat = noteHeartbeat(eventLoop.state, 40_001);
    const recovered = evaluateWatchdog(heartbeat, 40_001);
    expect(recovered.events).toEqual([expect.objectContaining({ event: "event_loop_recovery", durationMs: 30_001 })]);

    const active = noteProgress(createWatchdogState(0), 0, { operationId: "op", phase: "provider_stream" });
    const healthyHeartbeat = noteHeartbeat(active, 29_000);
    const operationStall = evaluateWatchdog(healthyHeartbeat, 30_000);
    expect(operationStall.events).toEqual([expect.objectContaining({ event: "operation_stall", operationId: "op" })]);
    const progress = noteProgress(operationStall.state, 31_000, { operationId: "op", phase: "provider_stream" });
    expect(evaluateWatchdog(progress, 31_000).events).toEqual([expect.objectContaining({ event: "operation_recovery", durationMs: 1_000 })]);
  });

  it.each(["idle", "approval", "clarification"] as const)("exempts %s from no-progress warnings", phase => {
    const state = noteProgress(createWatchdogState(0), 0, { operationId: "op", phase, exempt: true });
    expect(evaluateWatchdog(noteHeartbeat(state, 30_000), 30_000).events).toEqual([]);
  });

  it("does not warn while regular progress and heartbeats continue", () => {
    const active = noteProgress(createWatchdogState(0), 0, { operationId: "op", phase: "tools" });
    const progressed = noteProgress(noteHeartbeat(active, 25_000), 25_000, { operationId: "op", phase: "tools" });
    expect(evaluateWatchdog(noteHeartbeat(progressed, 50_000), 50_000).events).toEqual([]);
  });
});
