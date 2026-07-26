import { describe, expect, it, vi } from "vitest";
import { AuthenticationRequiredError, CredentialRejectedError } from "./auth.js";
import { backendAuthenticationRequiredFrame, parseBackendArgs, runBackend } from "./backend.js";
import { DevinApiError } from "widevin";

describe("private desktop backend entry", () => {
  it("accepts only private desktop, scheduler, Dream, and authentication modes", () => {
    expect(parseBackendArgs(["desktop"])).toEqual({ kind: "desktop" });
    expect(parseBackendArgs(["scheduler"])).toEqual({ kind: "scheduler" });
    expect(parseBackendArgs(["dream"])).toEqual({ kind: "dream" });
    expect(() => parseBackendArgs(["cron"])).toThrow("private Railgun backend");
    expect(() => parseBackendArgs(["--mode", "rpc"])).toThrow("private Railgun backend");
  });

  it("dispatches each private mode without a general CLI adapter", async () => {
    const runDesktop = vi.fn(async () => {});
    const runScheduler = vi.fn(async () => {});
    const runDream = vi.fn(async () => {});
    const runLogin = vi.fn(async () => {});
    const runLogout = vi.fn(async () => {});
    const dependencies = { runDesktop, runScheduler, runDream, runLogin, runLogout, establishHome: vi.fn() };
    for (const kind of ["desktop", "scheduler", "dream", "login", "logout"] as const) await runBackend({ kind }, dependencies);
    expect(runDesktop).toHaveBeenCalledOnce();
    expect(runScheduler).toHaveBeenCalledOnce();
    expect(runDream).toHaveBeenCalledOnce();
    expect(runLogin).toHaveBeenCalledOnce();
    expect(runLogout).toHaveBeenCalledOnce();
  });

  it.each(["scheduler", "dream"] as const)("exits %s normally when credentials are unavailable", async kind => {
    const operation = vi.fn(async () => { throw new AuthenticationRequiredError(); });
    const dependencies = kind === "scheduler"
      ? { runScheduler: operation, establishHome: vi.fn() }
      : { runDream: operation, establishHome: vi.fn() };
    await expect(runBackend({ kind }, dependencies)).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledOnce();
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
