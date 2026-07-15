// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { BackendPhase, BackendSnapshot, DesktopAgentEvent, RailgunDesktopApi, SessionSnapshot } from "../shared/types";
import { BackendStatus } from "./backendStatus";
import { readStoredArea } from "./routeStorage";
import { filterSessions } from "./tasks/filterSessions";

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; }
  observe(target: Element): void { this.callback([{ target, contentRect: { width: 1_300 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
  unobserve(): void {}
  disconnect(): void {}
} });

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const snapshot = (phase: BackendPhase): BackendSnapshot => ({
  mode: "mock",
  phase,
  scenarioId: "ready-idle",
  ...(phase === "failed" || phase === "disconnected" ? { error: "backend unavailable" } : {}),
  diagnostics: phase === "failed" ? ["diagnostic detail"] : [],
  transportLog: [{ direction: "system", text: "Starting backend" }],
});

const chatControls = {
  models: [{ id: "mock-model", name: "Mock Model", inputs: ["text"] as const, supportsTools: true, reasoning: false, contextWindow: 100_000, maxOutputTokens: 4_000 }],
  activeModelId: "mock-model", defaultModelId: null, messageCount: 0,
  moaPresets: [], activeMoaPreset: null, advisor: { enabled: false, modelId: null }, contextWindow: 100_000,
} as const;
const desktopSession = {
  id: "mock-new", startedAt: "2026-07-14T09:00:00.000Z", model: "mock-model", messageCount: 0,
  running: false, checkpoint: { state: "unsaved" as const }, transcript: [], todos: [],
};
const sessionApi = {
  listSessions: async () => [],
  resumeSession: async () => desktopSession,
  branchSession: async () => desktopSession,
  forkSession: async () => desktopSession,
  showSessionContextMenu: vi.fn(async () => null as "fork" | null),
  onSessionSnapshot: () => () => undefined,
};
const unusedControlMutation = async () => ({ controls: chatControls, persistence: "session-only" as const });
const controlApi = {
  getChatControls: async () => chatControls,
  setChatModel: unusedControlMutation,
  updateAgentControls: unusedControlMutation,
  compactContext: unusedControlMutation,
  getSettings: async () => ({
    models: chatControls.models, moaPresets: chatControls.moaPresets,
    general: { defaultModelId: null, operationTimeoutSeconds: 600 },
    agent: { moaPreset: null, advisor: chatControls.advisor },
    trust: { approvalMode: "manual" as const, reviewerModelId: null },
    provider: { state: "signed-in" as const, source: "cached" as const, message: "Signed in" },
    diagnostics: { phase: "ready" as const, message: "Healthy", entries: [], mockMode: true },
    running: false,
  }),
  updateSettings: async () => controlApi.getSettings(),
  signInDevin: async () => controlApi.getSettings(),
  signOutDevin: async () => controlApi.getSettings(),
  listCronJobs: async () => [],
  createCronJob: async (input: { schedule: string; prompt: string }) => ({ id: "cron", summary: "Every day", ...input }),
  updateCronJob: async (id: string, input: { schedule: string; prompt: string }) => ({ id, summary: "Every day", ...input }),
  deleteCronJob: async () => undefined,
  listSkills: async () => [],
  getSkill: async (name: string) => ({ name, description: "Test", disableModelInvocation: false, body: "# Test" }),
  listMcpServers: async () => [],
  upsertMcpServer: async () => [],
  removeMcpServer: async () => [],
};
const fileApi = {
  listFiles: async () => ({ entries: [] }),
  previewFile: async () => ({ kind: "text" as const, text: "" }),
  revealFile: async () => undefined,
};
const knowledgeApi = {
  listMemories: async () => [],
  createMemory: async (value: { content: string; category: string }) => ({ id: "memory", ...value, createdAt: 1 }),
  updateMemory: async (id: string, value: { content: string; category: string }) => ({ id, ...value, createdAt: 1 }),
  deleteMemory: async () => undefined,
  importNotes: async () => ({ cancelled: true as const }),
  searchNotes: async () => [],
  runDream: async () => ({ status: "skipped" as const, beforeCount: 0, afterCount: 0 }),
  onDreamProgress: () => () => undefined,
  listInstructionFiles: async () => [],
  getInstructionFile: async () => { throw new Error("unused"); },
  updateInstructionFile: async () => { throw new Error("unused"); },
};

describe("BackendStatus", () => {
  it.each([
    ["starting", "Starting Railgun"],
    ["ready", "Railgun is ready"],
    ["authentication-required", "Sign in to Devin"],
    ["failed", "Railgun could not start"],
    ["disconnected", "Railgun disconnected"],
  ] as const)("renders the %s screen", (phase, title) => {
    render(<BackendStatus snapshot={snapshot(phase)} />);
    const heading = screen.getByRole("heading", { name: title });
    expect(heading).toBeTruthy();
    const status = heading.closest("[role]");
    const isFailure = phase === "failed" || phase === "disconnected";
    expect(status?.getAttribute("role")).toBe(isFailure ? "alert" : "status");
    expect(status?.getAttribute("aria-live")).toBe(isFailure ? "assertive" : "polite");
    if (phase === "failed") expect(screen.getByText("diagnostic detail")).toBeTruthy();
  });

  it.each(["authentication-required", "failed", "disconnected"] as const)("offers retry for %s", async phase => {
    const onRetry = vi.fn(async () => undefined);
    render(<BackendStatus snapshot={snapshot(phase)} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
  });
});

describe("desktop shell", () => {
  it("filters sessions without reordering and validates versioned route restoration", () => {
    const sessions = [
      { id: "new", model: "Model A", startedAtLocal: "today", messageCount: 2, firstUserPreview: "Newest chat" },
      { id: "old", model: "Model B", startedAtLocal: "yesterday", messageCount: 4, firstUserPreview: "Older chat" },
    ];
    expect(filterSessions(sessions, "model")).toEqual(sessions);
    expect(filterSessions(sessions, "OLD")).toEqual([sessions[1]]);
    expect(filterSessions(sessions, "missing")).toEqual([]);
    expect(readStoredArea({ getItem: () => JSON.stringify({ version: 1, area: "settings" }) })).toBe("settings");
    expect(readStoredArea({ getItem: () => JSON.stringify({ version: 1, area: "automation" }) })).toBe("automation");
    expect(readStoredArea({ getItem: () => JSON.stringify({ version: 1, area: "knowledge" }) })).toBe("settings");
    expect(readStoredArea({ getItem: () => "not json" })).toBe("chat");
    expect(readStoredArea({ getItem: () => JSON.stringify({ version: 0, area: "settings" }) })).toBe("chat");
    expect(readStoredArea({ getItem: () => JSON.stringify({ version: 1, area: "obsolete" }) })).toBe("chat");
  });

  it("migrates the retired Knowledge route into Settings", async () => {
    window.localStorage.setItem("railgun.desktop.route", JSON.stringify({ version: 1, area: "knowledge" }));
    let backendListener: ((next: BackendSnapshot) => void) | undefined;
    const listSkills = vi.fn(async () => []);
    const api: RailgunDesktopApi = {
      ...knowledgeApi,
      getBackendSnapshot: async () => snapshot("starting"),
      restartBackend: async () => snapshot("starting"),
      onBackendSnapshot: listener => { backendListener = listener; return () => undefined; },
      listMockScenarios: async () => [],
      selectMockScenario: async () => snapshot("ready"),
      sendPrompt: async () => undefined,
      steerPrompt: async () => undefined,
      followUpPrompt: async () => undefined,
      abortPrompt: async () => undefined,
      openExternal: async () => undefined,
      ...fileApi,
      startNewChat: async () => desktopSession,
      ...sessionApi,
      ...controlApi,
      listSkills,
      onAgentEvent: () => () => undefined,
      respondToApproval: async () => undefined,
      respondToClarification: async () => undefined,
      onInteractionRequest: () => () => undefined,
      onAppCommand: () => () => undefined,
    };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "General" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Knowledge" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skills" })).toBeTruthy();
    expect(listSkills).not.toHaveBeenCalled();

    act(() => backendListener?.(snapshot("ready")));
    await waitFor(() => expect(screen.getByRole("heading", { name: "General" })).toBeTruthy());
    expect(listSkills).not.toHaveBeenCalled();
  });

  it("lists, filters, and resumes a rich saved session without rendering provider internals", async () => {
    const rich = {
      id: "rich", startedAt: "2026-07-14T08:45:00.000Z", model: "mock-model", messageCount: 3, running: false,
      checkpoint: { state: "saved" as const },
      transcript: [
        { role: "user" as const, text: "Rich history QA", messageId: 11 },
        { role: "assistant" as const, text: "Earlier restored answer", messageId: 12, branchable: true as const },
        { role: "user" as const, text: "Continue", messageId: 13 },
        { role: "assistant" as const, text: "Visible restored answer", messageId: 14, branchable: true as const },
      ],
      todos: [{ id: "todo", content: "Inspect restored todos", status: "in_progress" as const }],
    };
    const resumeSession = vi.fn(async () => rich);
    const branchSession = vi.fn()
      .mockRejectedValueOnce(new Error("mock branch failed"))
      .mockResolvedValue({ ...rich, messageCount: 2, transcript: rich.transcript.slice(0, 2) });
    const forkSession = vi.fn(async () => ({ ...rich, id: "rich-fork" }));
    const showSessionContextMenu = vi.fn(async (_id: string) => "fork" as "fork" | null);
    const api: RailgunDesktopApi = {
      ...knowledgeApi,
      getBackendSnapshot: async () => snapshot("ready"), restartBackend: async () => snapshot("starting"), onBackendSnapshot: () => () => undefined,
      listMockScenarios: async () => [], selectMockScenario: async () => snapshot("ready"),
      sendPrompt: async () => undefined, steerPrompt: async () => undefined, followUpPrompt: async () => undefined, abortPrompt: async () => undefined,
      openExternal: async () => undefined, ...fileApi, startNewChat: async () => desktopSession,
      listSessions: async () => [
        { id: "rich", model: "mock-model", startedAtLocal: "today", messageCount: 3, firstUserPreview: "Rich history QA" },
        { id: "older", model: "other", startedAtLocal: "yesterday", messageCount: 2, firstUserPreview: "Older chat" },
      ],
      resumeSession, branchSession, forkSession, showSessionContextMenu, onSessionSnapshot: () => () => undefined, ...controlApi,
      onAgentEvent: () => () => undefined, respondToApproval: async () => undefined, respondToClarification: async () => undefined,
      onInteractionRequest: () => () => undefined, onAppCommand: () => () => undefined,
    };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });
    render(<App />);
    const searchTasks = await screen.findByRole("button", { name: "Search tasks" });
    expect(document.querySelector(".brand-mark")).toBeNull();
    expect(document.querySelector(".brand span")?.textContent).toBe("Railgun");
    expect(searchTasks.className).toContain("task-search-button");
    expect(searchTasks.className).toContain("ui-button-sidebar-icon");
    expect(searchTasks.className).toContain("ui-button-compact-icon");
    expect(await screen.findByRole("button", { name: /Rich history QA/u })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Search tasks" })).toBeNull();
    fireEvent.click(searchTasks);
    expect(await screen.findByRole("heading", { name: "Find a Task" })).toBeTruthy();
    const taskSearchInput = screen.getByRole("textbox", { name: "Search tasks" });
    await waitFor(() => expect(document.activeElement).toBe(taskSearchInput));
    fireEvent.change(taskSearchInput, { target: { value: "other" } });
    expect(screen.queryByRole("option", { name: /Rich history QA/u })).toBeNull();
    fireEvent.change(taskSearchInput, { target: { value: "missing" } });
    expect(screen.getByText("No matching tasks")).toBeTruthy();
    fireEvent.change(taskSearchInput, { target: { value: "rich" } });
    fireEvent.keyDown(taskSearchInput, { key: "Enter" });
    await waitFor(() => expect(resumeSession).toHaveBeenCalledWith("rich"));
    expect(await screen.findByRole("heading", { name: "Rich history QA" })).toBeTruthy();
    expect(screen.getByText("Visible restored answer")).toBeTruthy();
    expect(screen.getByText("Inspect restored todos")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.queryByText(/provider internals/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
    expect(await screen.findByRole("heading", { name: "Scheduled" })).toBeTruthy();
    expect(window.localStorage.getItem("railgun.desktop.route")).toContain("automation");
    fireEvent.click(screen.getByRole("button", { name: /Rich history QA/u }));
    expect(await screen.findByText("Visible restored answer")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Branch from this message" }));
    expect(screen.getByRole("dialog", { name: "Branch from this message?" })).toBeTruthy();
    const summarize = screen.getByRole("checkbox", { name: "Summarize later messages" });
    expect((summarize as HTMLInputElement).checked).toBe(false);
    fireEvent.click(summarize);
    fireEvent.click(screen.getByRole("button", { name: /^Branch$/u }));
    expect((await screen.findByRole("alert")).textContent).toContain("mock branch failed");
    expect(screen.getByRole("dialog", { name: "Branch from this message?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Branch$/u }));
    await waitFor(() => expect(branchSession).toHaveBeenCalledTimes(2));
    expect(branchSession).toHaveBeenLastCalledWith(12, true);
    expect(screen.queryByText("Visible restored answer")).toBeNull();

    const richRow = screen.getByRole("button", { name: /Rich history QA/u });
    fireEvent.contextMenu(richRow);
    await waitFor(() => expect(showSessionContextMenu).toHaveBeenCalledWith("rich"));
    await waitFor(() => expect(forkSession).toHaveBeenCalledWith("rich"));
  });

  it("opens the native session context menu via keyboard and forks on selection", async () => {
    const forkSession = vi.fn(async () => desktopSession);
    const showSessionContextMenu = vi.fn(async (_id: string) => "fork" as "fork" | null);
    const api: RailgunDesktopApi = {
      ...knowledgeApi,
      getBackendSnapshot: async () => snapshot("ready"), restartBackend: async () => snapshot("starting"), onBackendSnapshot: () => () => undefined,
      listMockScenarios: async () => [], selectMockScenario: async () => snapshot("ready"),
      sendPrompt: async () => undefined, steerPrompt: async () => undefined, followUpPrompt: async () => undefined, abortPrompt: async () => undefined,
      openExternal: async () => undefined, ...fileApi, startNewChat: async () => desktopSession,
      listSessions: async () => [
        { id: "kbd-test", model: "mock-model", startedAtLocal: "today", messageCount: 1, firstUserPreview: "Keyboard test session" },
      ],
      resumeSession: async () => desktopSession, branchSession: async () => desktopSession,
      forkSession, showSessionContextMenu, onSessionSnapshot: () => () => undefined, ...controlApi,
      onAgentEvent: () => () => undefined, respondToApproval: async () => undefined, respondToClarification: async () => undefined,
      onInteractionRequest: () => () => undefined, onAppCommand: () => () => undefined,
    };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });
    render(<App />);
    const row = await screen.findByRole("button", { name: /Keyboard test session/u });

    // ContextMenu key
    fireEvent.keyDown(row, { key: "ContextMenu" });
    await waitFor(() => expect(showSessionContextMenu).toHaveBeenCalledWith("kbd-test"));
    await waitFor(() => expect(forkSession).toHaveBeenCalledWith("kbd-test"));

    showSessionContextMenu.mockClear();
    forkSession.mockClear();

    // Shift+F10
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    await waitFor(() => expect(showSessionContextMenu).toHaveBeenCalledWith("kbd-test"));
    await waitFor(() => expect(forkSession).toHaveBeenCalledWith("kbd-test"));
  });

  it("uses the product chat UI in mock mode and streams validated replies", async () => {
    const agentListeners = new Set<(event: DesktopAgentEvent) => void>();
    const sessionListeners = new Set<(snapshot: SessionSnapshot) => void>();
    const sendPrompt = vi.fn(async () => undefined);
    const abortPrompt = vi.fn(async () => undefined);
    const startNewChat = vi.fn(async () => desktopSession);
    const api: RailgunDesktopApi = {
      ...knowledgeApi,
      getBackendSnapshot: async () => snapshot("ready"),
      restartBackend: async () => snapshot("starting"),
      onBackendSnapshot: () => () => undefined,
      listMockScenarios: async () => [],
      selectMockScenario: async () => snapshot("ready"),
      sendPrompt,
      steerPrompt: async () => undefined,
      followUpPrompt: async () => undefined,
      abortPrompt,
      openExternal: async () => undefined,
      ...fileApi,
      startNewChat,
      ...sessionApi,
      ...controlApi,
      onSessionSnapshot: (listener) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
      onAgentEvent: (listener) => { agentListeners.add(listener); return () => agentListeners.delete(listener); },
      respondToApproval: async () => undefined,
      respondToClarification: async () => undefined,
      onInteractionRequest: () => () => undefined,
      onAppCommand: () => () => undefined,
    };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });

    render(<App />);
    await screen.findByRole("heading", { name: "What are we building?" });
    expect(screen.getByText("Mock backend")).toBeTruthy();
    const collapseSidebar = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapseSidebar.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapseSidebar);
    const expandSidebar = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expandSidebar.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".desktop-shell")?.classList.contains("sidebar-collapsed")).toBe(true);
    const collapsedNewTask = screen.getByRole("button", { name: "New Task" });
    expect(collapsedNewTask.className).toContain("ui-button-icon");
    expect(collapsedNewTask.className).toContain("ui-button-sidebar-icon");
    expect(collapsedNewTask.closest(".collapsed-sidebar-controls")).toBe(expandSidebar.closest(".collapsed-sidebar-controls"));
    expect(collapsedNewTask.querySelector(".lucide-square-pen")).not.toBeNull();
    fireEvent.click(expandSidebar);
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    const newTask = screen.getByRole("button", { name: "New Task" });
    const scheduled = screen.getByRole("button", { name: "Scheduled" });
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(newTask.className).toContain("sidebar-action");
    expect(scheduled.className).toContain("sidebar-action");
    expect(scheduled.querySelector(".lucide-clock")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Knowledge" })).toBeNull();
    expect(settings.className).toContain("sidebar-action");
    expect(newTask.closest(".sidebar-pinned-top")).not.toBeNull();
    expect(scheduled.closest(".sidebar-scroll")).not.toBeNull();
    expect(document.querySelector(".sidebar-footer")?.closest(".sidebar-bottom")).not.toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Message Railgun" }), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("hello"));
    expect(screen.getByText("hello")).toBeTruthy();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const paletteSearch = await screen.findByRole("textbox", { name: "Search commands" });
    fireEvent.change(paletteSearch, { target: { value: "stop response" } });
    fireEvent.keyDown(paletteSearch, { key: "Enter" });
    await waitFor(() => expect(abortPrompt).toHaveBeenCalledOnce());

    act(() => agentListeners.forEach(listener => listener({ type: "assistant-delta", text: "Mock response" })));
    act(() => agentListeners.forEach(listener => listener({ type: "run-end" })));
    expect(screen.getByText("Mock response")).toBeTruthy();
    act(() => agentListeners.forEach(listener => listener({ type: "tool-start", id: "todo", name: "todo" })));
    act(() => agentListeners.forEach(listener => listener({ type: "tool-end", id: "todo", name: "todo", failed: false, todos: [{ id: "done", content: "Desktop activity", status: "completed" }] })));
    act(() => agentListeners.forEach(listener => listener({ type: "subagent-start", index: 0, count: 1, goal: "Inspect dashboard persistence" })));
    act(() => agentListeners.forEach(listener => listener({ type: "advisor-note", severity: "concern", text: "Keep the dashboard visible after checkpointing." })));
    act(() => agentListeners.forEach(listener => listener({ type: "subagent-end", index: 0, goal: "Inspect dashboard persistence", result: "Dashboard remains visible." })));
    act(() => sessionListeners.forEach(listener => listener({
      ...desktopSession,
      messageCount: 2,
      checkpoint: { state: "saved" },
      transcript: [{ role: "user", text: "hello" }, { role: "assistant", text: "Mock response" }],
      todos: [{ id: "done", content: "Desktop activity", status: "completed" }],
    })));
    expect(screen.getByRole("complementary", { name: "Activity Dashboard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect dashboard persistence — Completed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Advisor — 1 note" })).toBeTruthy();
    expect(screen.queryByRole("separator", { name: "Resize inspector" })).toBeNull();
    const hideDashboard = screen.getByRole("button", { name: "Hide Activity Dashboard" });
    expect(hideDashboard.getAttribute("aria-pressed")).toBe("true");
    expect(hideDashboard.querySelector(".lucide-sliders-horizontal")).not.toBeNull();
    expect(hideDashboard.closest(".content-toolbar")).toBeNull();
    fireEvent.click(hideDashboard);
    expect(screen.queryByRole("complementary", { name: "Activity Dashboard" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize inspector" })).toBeNull();
    const showDashboard = screen.getByRole("button", { name: "Show Activity Dashboard" });
    expect(showDashboard.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(showDashboard);
    expect(screen.getByRole("complementary", { name: "Activity Dashboard" })).toBeTruthy();
    expect(screen.queryByRole("separator", { name: "Resize inspector" })).toBeNull();
    const openFiles = screen.getByRole("button", { name: "Open Files" });
    expect(openFiles.getAttribute("aria-pressed")).toBe("false");
    expect(openFiles.closest(".right-pane-controls")).toBe(showDashboard.closest(".right-pane-controls"));
    fireEvent.click(openFiles);
    expect(await screen.findByRole("complementary", { name: "Files workspace" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Activity Dashboard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide Activity Dashboard" }).closest(".single-pane-control")).not.toBeNull();
    expect(document.querySelector(".desktop-shell")?.classList.contains("inspector-overlay")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hide Activity Dashboard" }));
    const showOverlayDashboard = screen.getByRole("button", { name: "Show Activity Dashboard" });
    expect(showOverlayDashboard.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(showOverlayDashboard);
    expect(screen.getByRole("complementary", { name: "Activity Dashboard" })).toBeTruthy();
    expect(document.querySelector(".desktop-shell")?.classList.contains("inspector-overlay")).toBe(true);
    const collapseFiles = screen.getByRole("button", { name: "Collapse Files" });
    expect(collapseFiles.closest(".files-header")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open Files" })).toBeNull();
    fireEvent.click(collapseFiles);
    expect(screen.queryByRole("complementary", { name: "Files workspace" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "General" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Railgun" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Knowledge" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "System" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.queryByRole("navigation", { name: "Knowledge destinations" })).toBeNull();
    expect(await screen.findByText("No skills installed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New Task" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to Railgun" }));
    expect(await screen.findByText("Mock response")).toBeTruthy();
    expect(startNewChat).not.toHaveBeenCalled();
  });

  it("retries a failed backend from the shell", async () => {
    const restartBackend = vi.fn(async () => snapshot("starting"));
    const api: RailgunDesktopApi = {
      ...knowledgeApi,
      getBackendSnapshot: async () => snapshot("failed"),
      restartBackend,
      onBackendSnapshot: () => () => undefined,
      listMockScenarios: async () => [],
      selectMockScenario: async () => snapshot("ready"),
      sendPrompt: async () => undefined,
      steerPrompt: async () => undefined,
      followUpPrompt: async () => undefined,
      abortPrompt: async () => undefined,
      openExternal: async () => undefined,
      ...fileApi,
      startNewChat: async () => desktopSession,
      ...sessionApi,
      ...controlApi,
      onAgentEvent: () => () => undefined,
      respondToApproval: async () => undefined,
      respondToClarification: async () => undefined,
      onInteractionRequest: () => () => undefined,
      onAppCommand: () => () => undefined,
    };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });

    render(<App />);
    await screen.findByRole("button", { name: "Retry" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const paletteSearch = await screen.findByRole("textbox", { name: "Search commands" });
    fireEvent.change(paletteSearch, { target: { value: "retry backend" } });
    fireEvent.keyDown(paletteSearch, { key: "Enter" });
    await waitFor(() => expect(restartBackend).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "Starting Railgun" })).toBeTruthy();
  });

  it("coordinates keyboard and native commands through the accessible palette", async () => {
    let appCommandListener: ((command: import("../shared/types").AppCommand) => void) | undefined;
    const restartBackend = vi.fn(async () => snapshot("starting"));
    const startNewChat = vi.fn(async () => desktopSession);
    const api: RailgunDesktopApi = {
      ...knowledgeApi,
      getBackendSnapshot: async () => snapshot("ready"),
      restartBackend,
      onBackendSnapshot: () => () => undefined,
      listMockScenarios: async () => [],
      selectMockScenario: async () => snapshot("ready"),
      sendPrompt: async () => undefined,
      steerPrompt: async () => undefined,
      followUpPrompt: async () => undefined,
      abortPrompt: async () => undefined,
      openExternal: async () => undefined,
      ...fileApi,
      startNewChat,
      ...sessionApi,
      ...controlApi,
      onAgentEvent: () => () => undefined,
      respondToApproval: async () => undefined,
      respondToClarification: async () => undefined,
      onInteractionRequest: () => () => undefined,
      onAppCommand: (listener) => { appCommandListener = listener; return () => undefined; },
      listInstructionFiles: async () => [{ id: "soul", label: "~/.railgun/SOUL.md", status: "active" }],
      getInstructionFile: async () => ({ id: "soul", label: "~/.railgun/SOUL.md", status: "active", content: "Original" }),
      updateInstructionFile: async () => ({ id: "soul", label: "~/.railgun/SOUL.md", status: "active", content: "Saved" }),
    };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });

    render(<App />);
    const newChat = await screen.findByRole("button", { name: "New Task" });
    newChat.focus();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByRole("heading", { name: "Command Palette" })).toBeTruthy();
    const search = screen.getByRole("textbox", { name: "Search commands" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    await waitFor(() => expect(screen.getByRole("option", { name: /^New Task/u }).getAttribute("aria-selected")).toBe("true"));
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /^Task/u }).getAttribute("aria-selected")).toBe("true");

    fireEvent.change(search, { target: { value: "retry" } });
    const retry = screen.getByRole("option", { name: "Retry Backend" });
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(restartBackend).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Command Palette" })).toBeTruthy();

    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Command Palette" })).toBeNull());
    expect(document.activeElement).toBe(newChat);

    act(() => appCommandListener?.("command-palette"));
    const nativeSearch = await screen.findByRole("textbox", { name: "Search commands" });
    fireEvent.change(nativeSearch, { target: { value: "settings" } });
    fireEvent.keyDown(nativeSearch, { key: "Enter" });
    expect(await screen.findByRole("heading", { name: "General" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Instructions" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Markdown instructions" }), { target: { value: "Changed" } });

    act(() => appCommandListener?.("show-chat"));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    act(() => appCommandListener?.("new-chat"));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    expect(startNewChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));
    await waitFor(() => expect(startNewChat).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "New Task" })).toBeTruthy();
  });

  it("shows a boundary error when the initial backend snapshot rejects", async () => {
    const api: RailgunDesktopApi = {
      ...knowledgeApi,
      getBackendSnapshot: async () => { throw new Error("Snapshot validation failed"); },
      restartBackend: async () => snapshot("starting"),
      onBackendSnapshot: () => () => undefined,
      listMockScenarios: async () => [],
      selectMockScenario: async () => snapshot("ready"),
      sendPrompt: async () => undefined,
      steerPrompt: async () => undefined,
      followUpPrompt: async () => undefined,
      abortPrompt: async () => undefined,
      openExternal: async () => undefined,
      ...fileApi,
      startNewChat: async () => desktopSession,
      ...sessionApi,
      ...controlApi,
      onAgentEvent: () => () => undefined,
      respondToApproval: async () => undefined,
      respondToClarification: async () => undefined,
      onInteractionRequest: () => () => undefined,
      onAppCommand: () => () => undefined,
    };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });

    render(<App />);
    expect(await screen.findByText("Snapshot validation failed")).toBeTruthy();
  });
});
