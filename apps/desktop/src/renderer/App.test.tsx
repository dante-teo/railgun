// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, BackendStatus, MockPanel } from "./App";
import type { BackendPhase, BackendSnapshot, DesktopAgentEvent, RailgunDesktopApi } from "../shared/types";

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });

afterEach(cleanup);

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
      abortPrompt,
      startNewChat,
      onAgentEvent: (listener) => { agentListener = listener; return () => undefined; },
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
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(abortPrompt).toHaveBeenCalledOnce());

    act(() => agentListener?.({ type: "assistant-delta", text: "Mock response" }));
    expect(screen.getByText("Mock response")).toBeTruthy();
    act(() => agentListener?.({ type: "run-end" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Secure desktop boundary")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(startNewChat).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "Starting Railgun" })).toBeTruthy();
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
      abortPrompt: async () => undefined,
      startNewChat: async () => snapshot("starting"),
      onAgentEvent: () => () => undefined,
    };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(restartBackend).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "Starting Railgun" })).toBeTruthy();
  });

  it("shows a boundary error when the initial backend snapshot rejects", async () => {
    const api: RailgunDesktopApi = {
      getBackendSnapshot: async () => { throw new Error("Snapshot validation failed"); },
      restartBackend: async () => snapshot("starting"),
      onBackendSnapshot: () => () => undefined,
      listMockScenarios: async () => [],
      selectMockScenario: async () => snapshot("ready"),
      sendPrompt: async () => undefined,
      abortPrompt: async () => undefined,
      startNewChat: async () => snapshot("starting"),
      onAgentEvent: () => () => undefined,
    };
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });

    render(<App />);
    expect(await screen.findByText("Snapshot validation failed")).toBeTruthy();
  });
});
