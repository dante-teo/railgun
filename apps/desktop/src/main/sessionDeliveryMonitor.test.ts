import { describe, expect, it, vi } from "vitest";
import type { BackendSnapshot, SessionSummary } from "../shared/types";
import { createSessionDeliveryMonitor } from "./sessionDeliveryMonitor";

const summary = (id: string): SessionSummary => ({
  id,
  model: "model",
  startedAtLocal: "today",
  messageCount: 2,
  firstUserPreview: id,
});

describe("session delivery monitor", () => {
  it("broadcasts a list only when the ready backend cursor advances", async () => {
    let snapshot = { phase: "ready" } as BackendSnapshot;
    const listeners = new Set<(value: BackendSnapshot) => void>();
    let cursor = 0;
    const emit = vi.fn();
    const listSessions = vi.fn(async () => [summary(`session-${String(cursor)}`)]);
    const monitor = createSessionDeliveryMonitor({
      getSnapshot: () => snapshot,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      getCursor: async () => cursor,
      listSessions,
      emit,
      setInterval: vi.fn(() => 1 as never),
      clearInterval: vi.fn(),
    });

    monitor.start();
    await monitor.poll();
    expect(emit).not.toHaveBeenCalled();

    cursor = 1;
    await monitor.poll();
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenLastCalledWith([summary("session-1")]);
    await monitor.poll();
    expect(listSessions).toHaveBeenCalledOnce();

    snapshot = { ...snapshot, phase: "starting" };
    listeners.forEach(listener => listener(snapshot));
    cursor = 2;
    await monitor.poll();
    expect(emit).toHaveBeenCalledOnce();

    snapshot = { ...snapshot, phase: "ready" };
    listeners.forEach(listener => listener(snapshot));
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
    monitor.stop();
  });

  it("prevents overlapping polls and recovers after cursor errors", async () => {
    const first = Promise.withResolvers<number>();
    const getCursor = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValueOnce(new Error("backend restarting"))
      .mockResolvedValue(3);
    const emit = vi.fn();
    const monitor = createSessionDeliveryMonitor({
      getSnapshot: () => ({ phase: "ready" }),
      subscribe: () => () => undefined,
      getCursor,
      listSessions: async () => [summary("delivered")],
      emit,
      setInterval: vi.fn(() => 1 as never),
      clearInterval: vi.fn(),
    });

    monitor.start();
    const overlapping = monitor.poll();
    expect(getCursor).toHaveBeenCalledOnce();
    first.resolve(0);
    await overlapping;
    await vi.waitFor(() => expect(getCursor).toHaveBeenCalledOnce());

    await monitor.poll();
    expect(emit).not.toHaveBeenCalled();
    await monitor.poll();
    expect(emit).toHaveBeenCalledWith([summary("delivered")]);
    monitor.stop();
  });

  it("retries the same cursor when broadcasting the validated list fails", async () => {
    const emit = vi.fn()
      .mockImplementationOnce(() => { throw new Error("window unavailable"); })
      .mockImplementation(() => undefined);
    const listSessions = vi.fn(async () => [summary("delivered")]);
    const monitor = createSessionDeliveryMonitor({
      getSnapshot: () => ({ phase: "ready" }),
      subscribe: () => () => undefined,
      getCursor: async () => 1,
      listSessions,
      emit,
      setInterval: vi.fn(() => 1 as never),
      clearInterval: vi.fn(),
    });

    monitor.start();
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    await monitor.poll();

    expect(emit).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenCalledTimes(2);
    monitor.stop();
  });
});
