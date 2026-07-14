import { beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_IPC } from "../shared/types";

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}));

const { createDesktopApi } = await import("./preload");

const snapshot = {
  mode: "mock",
  phase: "ready",
  scenarioId: "ready-idle",
  diagnostics: [],
  transportLog: [],
} as const;

describe("preload desktop bridge", () => {
  beforeEach(() => {
    invoke.mockReset();
    on.mockReset();
    removeListener.mockReset();
  });

  it("exposes only the fixed API operations", () => {
    expect(exposeInMainWorld).toHaveBeenCalledOnce();
    const exposed = exposeInMainWorld.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(exposed).sort()).toEqual([
      "abortPrompt",
      "followUpPrompt",
      "getBackendSnapshot",
      "listMockScenarios",
      "onAgentEvent",
      "onAppCommand",
      "onBackendSnapshot",
      "onInteractionRequest",
      "openExternal",
      "respondToApproval",
      "respondToClarification",
      "restartBackend",
      "selectMockScenario",
      "sendPrompt",
      "startNewChat",
      "steerPrompt",
    ]);
    expect(exposed).not.toHaveProperty("invoke");
    expect(exposed).not.toHaveProperty("ipcRenderer");
  });

  it("uses fixed channels and validates invoke results", async () => {
    const api = createDesktopApi({ invoke, on, removeListener });
    invoke.mockResolvedValueOnce(snapshot);
    await expect(api.getBackendSnapshot()).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenCalledWith(DESKTOP_IPC.getBackendSnapshot);

    invoke.mockResolvedValueOnce(snapshot);
    await expect(api.restartBackend()).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.restartBackend);

    invoke.mockResolvedValueOnce([{ id: "ready-idle", label: "Ready", description: "Ready now" }]);
    await expect(api.listMockScenarios()).resolves.toHaveLength(1);
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.listMockScenarios);

    invoke.mockResolvedValueOnce({ ...snapshot, unexpected: true });
    await expect(api.getBackendSnapshot()).rejects.toThrow();
  });

  it("validates arguments before invoking", async () => {
    const api = createDesktopApi({ invoke, on, removeListener });
    await expect(api.selectMockScenario("invalid" as never)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce(snapshot);
    await expect(api.selectMockScenario("ready-idle")).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenCalledWith(DESKTOP_IPC.selectMockScenario, "ready-idle");

    invoke.mockResolvedValueOnce({ success: true });
    await expect(api.sendPrompt("hello")).rejects.toThrow();

    await expect(api.openExternal("javascript:alert(1)")).rejects.toThrow();
    await expect(api.openExternal("/relative")).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(2);

    invoke.mockResolvedValueOnce(undefined);
    await expect(api.steerPrompt("adjust this")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.steerPrompt, "adjust this");
    invoke.mockResolvedValueOnce(undefined);
    await expect(api.followUpPrompt("then this")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.followUpPrompt, "then this");
    invoke.mockResolvedValueOnce(undefined);
    await expect(api.openExternal("https://example.com/docs")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.openExternal, "https://example.com/docs");
  });

  it("exposes correlated interaction responses and withholds invalid interaction events", async () => {
    const api = createDesktopApi({ invoke, on, removeListener });
    invoke.mockResolvedValueOnce(undefined);
    await expect(api.respondToApproval("11111111-1111-4111-8111-111111111111", true)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(DESKTOP_IPC.respondToApproval, "11111111-1111-4111-8111-111111111111", true);
    await expect(api.respondToApproval("", true)).rejects.toThrow();
    await expect(api.respondToClarification("11111111-1111-4111-8111-111111111111", " ")).rejects.toThrow();

    const listener = vi.fn();
    const cleanup = api.onInteractionRequest(listener);
    const handler = on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.interactionRequest)?.[1] as
      (event: unknown, value: unknown) => void;
    handler({}, { type: "approval", id: "", command: "echo no" });
    handler({}, { type: "approval", id: "11111111-1111-4111-8111-111111111111", command: "echo yes" });
    expect(listener).toHaveBeenCalledOnce();
    cleanup();
    expect(removeListener).toHaveBeenCalledWith(DESKTOP_IPC.interactionRequest, handler);
  });

  it("starts a new backend chat and validates the reset snapshot", async () => {
    const api = createDesktopApi({ invoke, on, removeListener });
    invoke.mockResolvedValueOnce({ ...snapshot, phase: "starting", transportLog: [] });

    await expect(api.startNewChat()).resolves.toMatchObject({ phase: "starting" });
    expect(invoke).toHaveBeenCalledWith(DESKTOP_IPC.startNewChat);

    invoke.mockResolvedValueOnce({ ...snapshot, history: [] });
    await expect(api.startNewChat()).rejects.toThrow();
  });

  it("withholds invalid events and removes the exact listener", () => {
    const api = createDesktopApi({ invoke, on, removeListener });
    const listener = vi.fn();
    const cleanup = api.onBackendSnapshot(listener);
    const handler = on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.backendSnapshot)?.[1] as
      (event: unknown, value: unknown) => void;
    handler({}, { ...snapshot, mode: "foreign" });
    handler({}, snapshot);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(snapshot);

    cleanup();
    expect(removeListener).toHaveBeenCalledWith(DESKTOP_IPC.backendSnapshot, handler);
  });

  it("accepts only closed app commands and removes the exact listener", () => {
    const api = createDesktopApi({ invoke, on, removeListener });
    const listener = vi.fn();
    const cleanup = api.onAppCommand(listener);
    const handler = on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.appCommand)?.[1] as
      (event: unknown, value: unknown) => void;

    handler({}, "open-terminal");
    handler({}, { command: "new-chat" });
    handler({}, "new-chat");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("new-chat");

    cleanup();
    expect(removeListener).toHaveBeenCalledWith(DESKTOP_IPC.appCommand, handler);
  });

  it("buffers a valid app command until the renderer subscribes", () => {
    const api = createDesktopApi({ invoke, on, removeListener });
    const handler = on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.appCommand)?.[1] as
      (event: unknown, value: unknown) => void;
    const listener = vi.fn();

    handler({}, "new-chat");
    expect(listener).not.toHaveBeenCalled();
    api.onAppCommand(listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("new-chat");
  });
});
