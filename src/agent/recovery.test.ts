import { afterEach, describe, expect, it, vi } from "vitest";
import { DevinApiError, DevinAuthError, DevinProtocolError } from "widevin";
import { CredentialRejectedError } from "../auth.js";
import { callDevinWithRecovery, classifyError } from "./recovery.js";

describe("classifyError", () => {
  it("classifies DevinAuthError as reauth_required", () => {
    expect(classifyError(new DevinAuthError("auth expired"))).toBe("reauth_required");
  });

  it("classifies source-aware rejection and raw HTTP 401 as reauth_required", () => {
    expect(classifyError(new CredentialRejectedError("file", new DevinApiError("no", 401)))).toBe("reauth_required");
    expect(classifyError(new DevinApiError("no", 401))).toBe("reauth_required");
  });

  it.each([408, 429, 500, 502, 503, 599])("classifies DevinApiError with status %d as retry_with_backoff", status => {
    expect(classifyError(new DevinApiError("transient", status))).toBe("retry_with_backoff");
  });

  it.each([400, 403, 404, 422])("classifies DevinApiError with status %d as fail_immediately", status => {
    expect(classifyError(new DevinApiError("bad request", status))).toBe("fail_immediately");
  });

  it("classifies DevinApiError with status 413 as compress_and_retry", () => {
    expect(classifyError(new DevinApiError("too large", 413))).toBe("compress_and_retry");
  });

  it("classifies protocol and unrelated errors as immediate failures", () => {
    expect(classifyError(new DevinProtocolError("bad event"))).toBe("fail_immediately");
    expect(classifyError(new Error("unexpected"))).toBe("fail_immediately");
  });

  it("classifies fetch-style TypeError transport failures as retryable", () => {
    expect(classifyError(new TypeError("fetch failed"))).toBe("retry_with_backoff");
    expect(classifyError(new TypeError("unrelated type bug"))).toBe("fail_immediately");
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

  it("uses exactly 500ms and 1000ms delays between the three attempts", async () => {
    vi.useFakeTimers();
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce("ok");

    const result = callDevinWithRecovery(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
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

  it("compresses and retries on a 413 with no delay, calling compress exactly once", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new DevinApiError("too large", 413);
      return "ok";
    });
    const compress = vi.fn(async () => {});

    const result = await callDevinWithRecovery(fn, compress);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(compress).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("rejects after MAX_COMPRESS_ATTEMPTS repeated 413s even with a compress callback", async () => {
    const err = new DevinApiError("too large", 413);
    const fn = vi.fn(async () => {
      throw err;
    });
    const compress = vi.fn(async () => {});

    await expect(callDevinWithRecovery(fn, compress)).rejects.toBe(err);

    expect(fn).toHaveBeenCalledTimes(4);
    expect(compress).toHaveBeenCalledTimes(3);
  });

  it("rethrows a 413 immediately with no compress callback provided", async () => {
    const err = new DevinApiError("too large", 413);
    const fn = vi.fn(async () => {
      throw err;
    });

    await expect(callDevinWithRecovery(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
