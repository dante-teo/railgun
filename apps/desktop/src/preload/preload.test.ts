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
      "branchSession",
      "compactContext",
      "followUpPrompt",
      "forkSession",
      "getBackendSnapshot",
      "getChatControls",
      "getSettings",
      "listFiles",
      "listMockScenarios",
      "listSessions",
      "onAgentEvent",
      "onAppCommand",
      "onBackendSnapshot",
      "onInteractionRequest",
      "onSessionSnapshot",
      "openExternal",
      "previewFile",
      "respondToApproval",
      "respondToClarification",
      "restartBackend",
      "resumeSession",
      "revealFile",
      "selectMockScenario",
      "sendPrompt",
      "setChatModel",
      "signInDevin",
      "signOutDevin",
      "startNewChat",
      "steerPrompt",
      "updateAgentControls",
      "updateSettings",
    ]);
    expect(exposed).not.toHaveProperty("invoke");
    expect(exposed).not.toHaveProperty("ipcRenderer");
  });

  it("validates chat control arguments and results on fixed channels", async () => {
    const api = createDesktopApi({ invoke, on, removeListener });
    const controls = {
      models: [], activeModelId: "model-a", defaultModelId: null, messageCount: 0,
      moaPresets: [], activeMoaPreset: null, advisor: { enabled: false, modelId: null }, contextWindow: null,
    } as const;
    invoke.mockResolvedValueOnce(controls);
    await expect(api.getChatControls()).resolves.toEqual(controls);
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.getChatControls);

    invoke.mockResolvedValueOnce({ controls, persistence: "session-only" });
    await expect(api.setChatModel("model-a", "chat")).resolves.toMatchObject({ persistence: "session-only" });
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.setChatModel, "model-a", "chat");
    await expect(api.setChatModel("", "chat")).rejects.toThrow();
    await expect(api.setChatModel("model-a", "forever" as never)).rejects.toThrow();

    invoke.mockResolvedValueOnce({ controls, persistence: "saved" });
    await expect(api.updateAgentControls({ moaPreset: null })).resolves.toMatchObject({ persistence: "saved" });
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.updateAgentControls, { moaPreset: null });

    invoke.mockResolvedValueOnce({ controls, persistence: "session-only" });
    await expect(api.compactContext()).resolves.toMatchObject({ persistence: "session-only" });
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.compactContext);
  });

  it("validates settings snapshots and strict mutations without exposing raw configuration", async () => {
    const api = createDesktopApi({ invoke, on, removeListener });
    const settings = {
      models: [], moaPresets: [],
      general: { defaultModelId: null, operationTimeoutSeconds: 600 },
      agent: { moaPreset: null, advisor: { enabled: false, modelId: null } },
      trust: { approvalMode: "manual", reviewerModelId: null },
      provider: { state: "sign-in-required", source: "none", message: "Sign in" },
      diagnostics: { phase: "authentication-required", message: "Sign in", entries: [], mockMode: false },
      running: false,
    } as const;
    invoke.mockResolvedValueOnce(settings);
    await expect(api.getSettings()).resolves.toEqual(settings);
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.getSettings);

    invoke.mockResolvedValueOnce(settings);
    await expect(api.updateSettings({ section: "general", defaultModelId: null, operationTimeoutSeconds: 30 })).resolves.toEqual(settings);
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.updateSettings, { section: "general", defaultModelId: null, operationTimeoutSeconds: 30 });
    await expect(api.updateSettings({ section: "trust", approvalMode: "smart", reviewerModelId: null })).rejects.toThrow(/requires a model/u);
    await expect(api.updateSettings({ section: "general", defaultModelId: null, operationTimeoutSeconds: 30, token: "secret" } as never)).rejects.toThrow();

    invoke.mockResolvedValueOnce({ ...settings, rawConfig: {} });
    await expect(api.signInDevin()).rejects.toThrow();
    expect(Object.keys(api)).not.toContain("getConfig");
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

  it("validates file paths and bounded results on fixed channels", async () => {
    const api = createDesktopApi({ invoke, on, removeListener });
    invoke.mockResolvedValueOnce({ entries: [{ name: ".hidden", kind: "file", symlink: false }] });
    await expect(api.listFiles([])).resolves.toEqual({ entries: [{ name: ".hidden", kind: "file", symlink: false }] });
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.listFiles, []);

    await expect(api.previewFile(["..", "secret"])).rejects.toThrow();
    await expect(api.listFiles(["/tmp"])).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);

    invoke.mockResolvedValueOnce({ kind: "text", text: "hello" });
    await expect(api.previewFile(["notes.txt"])).resolves.toEqual({ kind: "text", text: "hello" });
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.previewFile, ["notes.txt"]);

    invoke.mockResolvedValueOnce({ kind: "text", text: "macOS filename" });
    await expect(api.previewFile(["back\\slash.txt"])).resolves.toEqual({ kind: "text", text: "macOS filename" });
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.previewFile, ["back\\slash.txt"]);

    invoke.mockResolvedValueOnce({ kind: "image", dataUrl: "file:///secret.png", width: 1, height: 1 });
    await expect(api.previewFile(["image.png"])).rejects.toThrow();
    invoke.mockResolvedValueOnce(undefined);
    await expect(api.revealFile(["notes.txt"])).resolves.toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.revealFile, ["notes.txt"]);
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

  it("starts and resumes desktop sessions with validated snapshots", async () => {
    const api = createDesktopApi({ invoke, on, removeListener });
    const session = { id: "session-1", startedAt: "2026-07-14T09:00:00.000Z", model: "mock", messageCount: 0, running: false, checkpoint: { state: "unsaved" }, transcript: [], todos: [] };
    invoke.mockResolvedValueOnce(session);

    await expect(api.startNewChat()).resolves.toEqual(session);
    expect(invoke).toHaveBeenCalledWith(DESKTOP_IPC.startNewChat);

    invoke.mockResolvedValueOnce({ ...snapshot, history: [] });
    await expect(api.startNewChat()).rejects.toThrow();

    invoke.mockResolvedValueOnce([{ id: "session-1", model: "mock", startedAtLocal: "today", messageCount: 2, firstUserPreview: "Hello" }]);
    await expect(api.listSessions()).resolves.toHaveLength(1);
    invoke.mockResolvedValueOnce(session);
    await expect(api.resumeSession("session-1")).resolves.toEqual(session);
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.resumeSession, "session-1");
    await expect(api.resumeSession(" ")).rejects.toThrow();

    invoke.mockResolvedValueOnce({ ...session, checkpoint: { state: "saved" }, transcript: [{ role: "user", text: "One", messageId: 7 }] });
    await expect(api.branchSession(7, true)).resolves.toMatchObject({ transcript: [{ messageId: 7 }] });
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.branchSession, 7, true);
    await expect(api.branchSession(0, false)).rejects.toThrow();
    await expect(api.branchSession(7, "yes" as never)).rejects.toThrow();

    invoke.mockResolvedValueOnce({ ...session, id: "fork-1", checkpoint: { state: "saved" } });
    await expect(api.forkSession("session-1")).resolves.toMatchObject({ id: "fork-1" });
    expect(invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.forkSession, "session-1");
    await expect(api.forkSession(" ")).rejects.toThrow();
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
