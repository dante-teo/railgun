// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSnapshot, RailgunDesktopApi, SettingsSnapshot } from "../../shared/types";
import { SettingsPage } from "./SettingsPage";

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });

const backend: BackendSnapshot = { mode: "real", phase: "ready", diagnostics: [], transportLog: [] };
const snapshot: SettingsSnapshot = {
  models: [{ id: "model-a", name: "Model A", inputs: ["text"], supportsTools: true, reasoning: false, contextWindow: 10_000, maxOutputTokens: 2_000 }],
  moaPresets: [],
  general: { defaultModelId: null, operationTimeoutSeconds: 600 },
  agent: { moaPreset: null, advisor: { enabled: false, modelId: null } },
  trust: { approvalMode: "manual", reviewerModelId: null },
  provider: { state: "signed-in", source: "cached", message: "Cached credential" },
  diagnostics: { phase: "ready", message: "Healthy", entries: [], mockMode: false },
  running: false,
};

afterEach(cleanup);

describe("SettingsPage", () => {
  it("searches descriptions, focuses a selected row, and confirms dirty navigation", async () => {
    const updateSettings = vi.fn(async () => snapshot);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      getSettings: async () => snapshot,
      updateSettings,
      signInDevin: async () => snapshot,
      signOutDevin: async () => snapshot,
    } as unknown as RailgunDesktopApi });
    render(<SettingsPage backend={backend} agentRunning={false} scenarios={[]} onBack={vi.fn()} onSaved={vi.fn()} onRetryBackend={vi.fn()} onSelectScenario={vi.fn()} />);
    await screen.findByText("Default model");

    const search = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "reviews tool approvals" } });
    fireEvent.click(screen.getByRole("option", { name: /Smart-review model/u }));
    expect(await screen.findByRole("heading", { name: "Trust" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe("setting-reviewer-model"));

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Operation timeout in seconds" }), { target: { value: "30" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ section: "general", defaultModelId: null, operationTimeoutSeconds: 30 }));
  });

  it("uses an explicit destructive confirmation for cached sign-out", async () => {
    const signOutDevin = vi.fn(async () => ({ ...snapshot, provider: { state: "sign-in-required" as const, source: "none" as const, message: "Sign in" } }));
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      getSettings: async () => snapshot,
      updateSettings: async () => snapshot,
      signInDevin: async () => snapshot,
      signOutDevin,
    } as unknown as RailgunDesktopApi });
    render(<SettingsPage backend={backend} agentRunning={false} scenarios={[]} onBack={vi.fn()} onSaved={vi.fn()} onRetryBackend={vi.fn()} onSelectScenario={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Provider" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));
    expect(screen.getByText(/removes only Railgun’s cached credential/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));
    await waitFor(() => expect(signOutDevin).toHaveBeenCalledOnce());
  });

  it("refreshes provider data and controls when backend and run state change", async () => {
    const authenticationRequired: BackendSnapshot = {
      mode: "real", phase: "authentication-required", diagnostics: [], transportLog: [],
    };
    let current: SettingsSnapshot = {
      ...snapshot,
      models: [],
      provider: { state: "sign-in-required", source: "none", message: "Sign in required" },
      diagnostics: { phase: "authentication-required", message: "Sign in", entries: [], mockMode: false },
      running: true,
    };
    const getSettings = vi.fn(async () => current);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      getSettings,
      updateSettings: async () => current,
      signInDevin: async () => current,
      signOutDevin: async () => current,
    } as unknown as RailgunDesktopApi });
    const callbacks = { onBack: vi.fn(), onSaved: vi.fn(), onRetryBackend: vi.fn(), onSelectScenario: vi.fn() };
    const { rerender } = render(<SettingsPage backend={authenticationRequired} agentRunning scenarios={[]} {...callbacks} />);

    const model = await screen.findByRole("combobox", { name: /Default model/u });
    expect((model as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Provider" }));
    expect(screen.getByText("Sign in required")).toBeTruthy();

    current = snapshot;
    rerender(<SettingsPage backend={backend} agentRunning={false} scenarios={[]} {...callbacks} />);
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Cached credential")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect((screen.getByRole("combobox", { name: /Default model/u }) as HTMLSelectElement).disabled).toBe(false);
    expect(screen.getByRole("option", { name: "Model A" })).toBeTruthy();
  });
});
