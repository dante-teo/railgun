import { describe, expect, it, vi } from "vitest";
import { AuthenticationRequiredError } from "./auth.js";
import { parseBackendArgs, runBackend } from "./backend.js";

describe("private desktop backend entry", () => {
  it("accepts only internal desktop, scheduler, Dream, and authentication modes", () => {
    expect(parseBackendArgs(["desktop"])).toEqual({ kind: "desktop" });
    expect(parseBackendArgs(["scheduler"])).toEqual({ kind: "scheduler" });
    expect(parseBackendArgs(["dream"])).toEqual({ kind: "dream" });
    expect(() => parseBackendArgs(["--mode", "rpc"])).toThrow("private Railgun desktop backend");
    expect(() => parseBackendArgs(["cron", "install"])).toThrow("private Railgun desktop backend");
  });

  it("maps background modes to the existing scheduler and Dream implementations", async () => {
    const dispatch = vi.fn(async () => {});
    await runBackend({ kind: "scheduler" }, { dispatch, establishHome: vi.fn() });
    await runBackend({ kind: "dream" }, { dispatch, establishHome: vi.fn() });
    expect(dispatch).toHaveBeenNthCalledWith(1, { kind: "cron" });
    expect(dispatch).toHaveBeenNthCalledWith(2, { kind: "dream" });
  });

  it("exits the scheduler normally when credentials are unavailable", async () => {
    const dispatch = vi.fn(async () => { throw new AuthenticationRequiredError(); });
    await expect(runBackend({ kind: "scheduler" }, { dispatch, establishHome: vi.fn() })).resolves.toBeUndefined();
  });
});
