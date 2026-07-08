import { afterEach, describe, expect, it, vi } from "vitest";
import { DevinApiError, DevinAuthError } from "widevin";
import { callDevinWithRecovery, classifyError } from "./recovery.js";

describe("classifyError", () => {
  it("classifies DevinAuthError as reauth_required", () => {
    expect(classifyError(new DevinAuthError("auth expired"))).toBe("reauth_required");
  });

  it.each([429, 502, 503])("classifies DevinApiError with status %d as retry_with_backoff", status => {
    expect(classifyError(new DevinApiError("transient", status))).toBe("retry_with_backoff");
  });

  it.each([400, 413])("classifies DevinApiError with status %d as fail_immediately", status => {
    expect(classifyError(new DevinApiError("bad request", status))).toBe("fail_immediately");
  });

  it("classifies DevinApiError with an unlisted status as retry_with_backoff", () => {
    expect(classifyError(new DevinApiError("server error", 500))).toBe("retry_with_backoff");
  });

  it("classifies a plain Error as retry_with_backoff", () => {
    expect(classifyError(new Error("unexpected"))).toBe("retry_with_backoff");
  });
});

describe("callDevinWithRecovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds on the first try with no delay needed", async () => {
    const fn = vi.fn(async () => "ok");

    const result = await callDevinWithRecovery(fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable error twice before succeeding on the 3rd attempt", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new DevinApiError("rate limited", 429);
      return "ok";
    });

    const resultPromise = callDevinWithRecovery(fn);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rejects after MAX_ATTEMPTS (3) calls when the error is always retryable", async () => {
    vi.useFakeTimers();
    const err = new DevinApiError("rate limited", 429);
    const fn = vi.fn(async () => {
      throw err;
    });

    const resultPromise = callDevinWithRecovery(fn);
    const assertion = expect(resultPromise).rejects.toBe(err);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rejects immediately without retrying when the error is fail_immediately", async () => {
    const err = new DevinApiError("bad request", 400);
    const fn = vi.fn(async () => {
      throw err;
    });

    await expect(callDevinWithRecovery(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
