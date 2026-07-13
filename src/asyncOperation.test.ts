import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationTimeoutError, runBoundedOperation } from "./asyncOperation.js";

describe("runBoundedOperation", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts the scoped signal and rejects at the deadline", async () => {
    vi.useFakeTimers();
    let scopedSignal: AbortSignal | undefined;
    const result = runBoundedOperation(new AbortController().signal, 25, "Tool x", signal => {
      scopedSignal = signal;
      return new Promise<string>(() => {});
    });
    const expectation = expect(result).rejects.toEqual(new OperationTimeoutError("Tool x", 25));

    await vi.advanceTimersByTimeAsync(25);

    await expectation;
    expect(scopedSignal?.aborted).toBe(true);
  });

  it("settles immediately on user cancellation and absorbs a late rejection", async () => {
    const controller = new AbortController();
    const deferred = Promise.withResolvers<string>();
    const result = runBoundedOperation(controller.signal, 1_000, "Provider stream", () => deferred.promise);
    controller.abort(new DOMException("Stopped by user", "AbortError"));

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    deferred.reject(new Error("late"));
    await Promise.resolve();
  });

  it("cleans up its deadline after success", async () => {
    vi.useFakeTimers();
    await expect(runBoundedOperation(new AbortController().signal, 50, "work", async () => 42)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });
});
