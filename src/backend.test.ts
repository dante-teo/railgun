import { describe, expect, it, vi } from "vitest";
import { AuthenticationRequiredError, CredentialRejectedError } from "./auth.js";
import { backendAuthenticationRequiredFrame, parseBackendArgs, runBackend } from "./backend.js";
import { DevinApiError } from "widevin";

describe("private desktop backend entry", () => {
  it("accepts internal desktop, scheduler aliases, Dream, and authentication modes", () => {
    expect(parseBackendArgs(["desktop"])).toEqual({ kind: "desktop" });
    expect(parseBackendArgs(["scheduler"])).toEqual({ kind: "scheduler" });
    expect(parseBackendArgs(["cron"])).toEqual({ kind: "scheduler" });
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

  it("emits authentication startup status only for desktop RPC launches", () => {
    expect(
      backendAuthenticationRequiredFrame({ kind: "desktop" }, new AuthenticationRequiredError()),
    ).toBe('{"type":"startup_status","status":"authentication_required","credential_source":"file"}');
    expect(
      backendAuthenticationRequiredFrame(
        { kind: "desktop" },
        new CredentialRejectedError("environment", new DevinApiError("rejected", 401)),
      ),
    ).toBe('{"type":"startup_status","status":"authentication_required","credential_source":"environment"}');
    expect(
      backendAuthenticationRequiredFrame({ kind: "login" }, new AuthenticationRequiredError()),
    ).toBeUndefined();
  });
});
