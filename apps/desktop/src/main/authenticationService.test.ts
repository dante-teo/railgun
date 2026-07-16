import { describe, expect, it, vi } from "vitest";
import { createAuthenticationCoordinator, createAuthenticationHelperSpec, createAuthenticationService } from "./authenticationService";
import { createMutationQueue } from "./mutationQueue";

describe("desktop authentication helper", () => {
  it("builds development and packaged CLI invocations without desktop RPC mode", () => {
    expect(createAuthenticationHelperSpec({ kind: "development", repositoryRoot: "/repo" }, "login")).toMatchObject({
      command: "pnpm", args: ["exec", "tsx", "/repo/src/backend.ts", "login"], cwd: "/repo",
    });
    expect(createAuthenticationHelperSpec({ kind: "packaged", resourcesPath: "/resources", executablePath: "/Electron", workingDirectory: "/home" }, "logout")).toMatchObject({
      command: "/Electron", args: ["/resources/backend/railgun/dist/backend.js", "logout"], cwd: "/home",
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
    });
  });

  it("is single-flight, restarts only after success, and retains the backend on failure", async () => {
    let resolveRun!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { resolveRun = resolve; }));
    const restart = vi.fn(async () => undefined);
    const auth = createAuthenticationService({ kind: "development", repositoryRoot: "/repo" }, restart, run);
    const signingIn = auth.signIn();
    await expect(auth.signOut()).rejects.toThrow(/already in progress/u);
    expect(restart).not.toHaveBeenCalled();
    resolveRun();
    await signingIn;
    expect(restart).toHaveBeenCalledWith("login");

    run.mockRejectedValueOnce(new Error("login failed"));
    await expect(auth.signIn()).rejects.toThrow("login failed");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("blocks task mutations for the entire authentication operation", async () => {
    let finishSignIn!: () => void;
    const signIn = vi.fn(() => new Promise<void>(resolve => { finishSignIn = resolve; }));
    const coordinator = createAuthenticationCoordinator({
      mutations: createMutationQueue(),
      isAgentRunning: async () => false,
      signIn,
      signOut: async () => undefined,
      snapshot: async () => "ready",
    });

    const operation = coordinator.mutate("login");
    await vi.waitFor(() => expect(signIn).toHaveBeenCalledOnce());
    expect(() => coordinator.assertTaskMutationAllowed()).toThrow(/authentication is in progress/u);
    await expect(coordinator.mutate("logout")).rejects.toThrow(/already in progress/u);

    finishSignIn();
    await expect(operation).resolves.toBe("ready");
    expect(() => coordinator.assertTaskMutationAllowed()).not.toThrow();
  });

  it("does not begin authentication while an agent is running", async () => {
    const signIn = vi.fn(async () => undefined);
    const coordinator = createAuthenticationCoordinator({
      mutations: createMutationQueue(),
      isAgentRunning: async () => true,
      signIn,
      signOut: async () => undefined,
      snapshot: async () => "unused",
    });
    await expect(coordinator.mutate("login")).rejects.toThrow(/agent is running/u);
    expect(signIn).not.toHaveBeenCalled();
    expect(() => coordinator.assertTaskMutationAllowed()).not.toThrow();
  });
});
