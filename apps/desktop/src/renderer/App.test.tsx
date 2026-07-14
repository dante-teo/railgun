// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, MockPanel } from "./App";
import type { BackendPhase, BackendSnapshot, DesktopAgentEvent, RailgunDesktopApi } from "../shared/types";
import { BackendStatus } from "./backendStatus";
import { readStoredArea } from "./routeStorage";
import { filterSessions } from "./tasks/filterSessions";

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });

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
  onSessionSnapshot: () => () => undefined,
};
const unusedControlMutation = async () => ({ controls: chatControls, persistence: "session-only" as const });
const controlApi = {
  getChatControls: async () => chatControls,
  setChatModel: unusedControlMutation,
  updateAgentControls: unusedControlMutation,
  compactContext: unusedControlMutation,
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

describe("MockPanel", () => {
  it("opens the scenario menu, updates the selection, and restarts that backend", async () => {
    const onSelect = vi.fn(async () => undefined);
    render(<MockPanel
      snapshot={snapshot("ready")}
      scenarios={[
        { id: "ready-idle", label: "Ready / idle", description: "Ready now" },
        { id: "delayed-startup", label: "Delayed startup", description: "Ready later" },
      ]}
      onSelect={onSelect}
    />);

    const scenarioSelect = screen.getByRole("combobox", { name: "Mock scenario" });
    expect(scenarioSelect).toBeTruthy();
    expect(screen.getByText("Ready now")).toBeTruthy();
    expect(screen.getByText("Starting backend")).toBeTruthy();
    fireEvent.keyDown(scenarioSelect, { key: "ArrowDown" });
    const delayedOption = await screen.findByRole("option", { name: "Delayed startup" });
    expect(delayedOption.closest("[data-side]")?.className).toContain("radix-select-trigger-width");
    fireEvent.click(delayedOption);
    expect(screen.getByText("Ready later")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart backend" }));
    expect(onSelect).toHaveBeenCalledWith("delayed-startup");
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
    expect(readStoredArea({ getItem: () => "not json" })).toBe("chat");
    expect(readStoredArea({ getItem: () => JSON.stringify({ version: 0, area: "settings" }) })).toBe("chat");
    expect(readStoredArea({ getItem: () => JSON.stringify({ version: 1, area: "obsolete" }) })).toBe("chat");
  });

  it("lists, filters, and resumes a rich saved session without rendering provider internals", async () => {
    const rich = {
      id: "rich", startedAt: "2026-07-14T08:45:00.000Z", model: "mock-model", messageCount: 3, running: false,
      checkpoint: { state: "saved" as const },
      transcript: [{ role: "user" as const, text: "Rich history QA" }, { role: "assistant" as const, text: "Visible restored answer" }],
      todos: [{ id: "todo", content: "Inspect restored todos", status: "in_progress" as const }],
    };
    const resumeSession = vi.fn(async () => rich);
    const api: RailgunDesktopApi = {
      getBackendSnapshot: async () => snapshot("ready"), restartBackend: async () => snapshot("starting"), onBackendSnapshot: () => () => undefined,
      listMockScenarios: async () => [], selectMockScenario: async () => snapshot("ready"),
      sendPrompt: async () => undefined, steerPrompt: async () => undefined, followUpPrompt: async () => undefined, abortPrompt: async () => undefined,
      openExternal: async () => undefined, startNewChat: async () => desktopSession,
      listSessions: async () => [
        { id: "rich", model: "mock-model", startedAtLocal: "today", messageCount: 3, firstUserPreview: "Rich history QA" },
        { id: "older", model: "other", startedAtLocal: "yesterday", messageCount: 2, firstUserPreview: "Older chat" },
      ],
      resumeSession, onSessionSnapshot: () => () => undefined, ...controlApi,
      onAgentEvent: () => () => undefined, respondToApproval: async () => undefined, respondToClarification: async () => undefined,
      onInteractionRequest: () => () => undefined, onAppCommand: () => () => undefined,
    };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });
    render(<App />);
    const searchTasks = await screen.findByRole("button", { name: "Search tasks" });
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
  });

  it("uses the product chat UI in mock mode and streams validated replies", async () => {
    const agentListeners = new Set<(event: DesktopAgentEvent) => void>();
    const sendPrompt = vi.fn(async () => undefined);
    const abortPrompt = vi.fn(async () => undefined);
    const startNewChat = vi.fn(async () => desktopSession);
    const api: RailgunDesktopApi = {
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
      startNewChat,
      ...sessionApi,
      ...controlApi,
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
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(newTask.className).toContain("sidebar-action");
    expect(settings.className).toContain("sidebar-action");
    expect(settings.previousElementSibling?.classList.contains("sidebar-divider")).toBe(true);
    expect(document.querySelector(".sidebar-footer")?.previousElementSibling).toBe(settings);
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
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
    expect(screen.queryByRole("separator", { name: "Resize inspector" })).toBeNull();
    const hideTodos = screen.getByRole("button", { name: "Hide Todos" });
    expect(hideTodos.getAttribute("aria-pressed")).toBe("true");
    expect(hideTodos.querySelector(".lucide-sliders-horizontal")).not.toBeNull();
    expect(hideTodos.closest(".content-toolbar")).toBeNull();
    fireEvent.click(hideTodos);
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize inspector" })).toBeNull();
    const showTodos = screen.getByRole("button", { name: "Show Todos" });
    expect(showTodos.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(showTodos);
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
    expect(screen.queryByRole("separator", { name: "Resize inspector" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Secure desktop boundary")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New Task" }));
    await waitFor(() => expect(startNewChat).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "What are we building?" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
  });

  it("retries a failed backend from the shell", async () => {
    const restartBackend = vi.fn(async () => snapshot("starting"));
    const api: RailgunDesktopApi = {
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
    const api: RailgunDesktopApi = {
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
      startNewChat: async () => desktopSession,
      ...sessionApi,
      ...controlApi,
      onAgentEvent: () => () => undefined,
      respondToApproval: async () => undefined,
      respondToClarification: async () => undefined,
      onInteractionRequest: () => () => undefined,
      onAppCommand: (listener) => { appCommandListener = listener; return () => undefined; },
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
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();

    act(() => appCommandListener?.("show-chat"));
    expect(await screen.findByRole("heading", { name: "New Task" })).toBeTruthy();
  });

  it("shows a boundary error when the initial backend snapshot rejects", async () => {
    const api: RailgunDesktopApi = {
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
