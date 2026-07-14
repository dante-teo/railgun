// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, BackendStatus, MockPanel } from "./App";
import type { BackendPhase, BackendSnapshot, DesktopAgentEvent, RailgunDesktopApi } from "../shared/types";

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
  it("uses the product chat UI in mock mode and streams validated replies", async () => {
    let agentListener: ((event: DesktopAgentEvent) => void) | undefined;
    const sendPrompt = vi.fn(async () => undefined);
    const abortPrompt = vi.fn(async () => undefined);
    const startNewChat = vi.fn(async () => snapshot("starting"));
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
      onAgentEvent: (listener) => { agentListener = listener; return () => undefined; },
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
    fireEvent.click(expandSidebar);
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Message Railgun" }), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("hello"));
    expect(screen.getByText("hello")).toBeTruthy();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const paletteSearch = await screen.findByRole("textbox", { name: "Search commands" });
    fireEvent.change(paletteSearch, { target: { value: "stop response" } });
    fireEvent.keyDown(paletteSearch, { key: "Enter" });
    await waitFor(() => expect(abortPrompt).toHaveBeenCalledOnce());

    act(() => agentListener?.({ type: "assistant-delta", text: "Mock response" }));
    act(() => agentListener?.({ type: "run-end" }));
    expect(screen.getByText("Mock response")).toBeTruthy();
    act(() => agentListener?.({ type: "tool-start", id: "todo", name: "todo" }));
    act(() => agentListener?.({ type: "tool-end", id: "todo", name: "todo", failed: false, todos: [{ id: "done", content: "Desktop activity", status: "completed" }] }));
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize inspector" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Secure desktop boundary")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(startNewChat).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "Starting Railgun" })).toBeTruthy();
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
      startNewChat: async () => snapshot("starting"),
      onAgentEvent: () => () => undefined,
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
      startNewChat: async () => snapshot("starting"),
      onAgentEvent: () => () => undefined,
      onAppCommand: (listener) => { appCommandListener = listener; return () => undefined; },
    };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });

    render(<App />);
    const newChat = await screen.findByRole("button", { name: "New chat" });
    newChat.focus();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByRole("heading", { name: "Command Palette" })).toBeTruthy();
    const search = screen.getByRole("textbox", { name: "Search commands" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    await waitFor(() => expect(screen.getByRole("option", { name: /^New Chat/u }).getAttribute("aria-selected")).toBe("true"));
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /^Chat/u }).getAttribute("aria-selected")).toBe("true");

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
    expect(await screen.findByRole("heading", { name: "New chat" })).toBeTruthy();
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
      startNewChat: async () => snapshot("starting"),
      onAgentEvent: () => () => undefined,
      onAppCommand: () => () => undefined,
    };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });

    render(<App />);
    expect(await screen.findByText("Snapshot validation failed")).toBeTruthy();
  });
});
