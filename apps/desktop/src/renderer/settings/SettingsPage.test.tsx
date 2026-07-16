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
  archives: { archiveRetentionDays: 7 },
  provider: { state: "signed-in", source: "cached", message: "Cached credential" },
  diagnostics: { phase: "ready", message: "Healthy", entries: [], mockMode: false },
  running: false,
};

afterEach(cleanup);

describe("SettingsPage", () => {
  it("serializes restore requests so a double-click cannot report a false failure", async () => {
    let resolveRestore!: () => void;
    const restore = new Promise<void>(resolve => { resolveRestore = resolve; });
    const unarchiveSession = vi.fn(async () => restore);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      getSettings: async () => snapshot,
      updateSettings: async () => snapshot,
      listArchivedSessions: async () => [{ id: "archive-1", model: "model-a", startedAtLocal: "today", messageCount: 2, firstUserPreview: "Restore once", archivedAt: "2026-07-15T08:00:00.000Z" }],
      unarchiveSession,
    } as unknown as RailgunDesktopApi });
    render(<SettingsPage backend={backend} agentRunning={false} scenarios={[]} onBack={vi.fn()} onDirtyChange={vi.fn()} onSaved={vi.fn()} onRetryBackend={vi.fn()} onSelectScenario={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Archived Tasks" }));
    const restoreButton = await screen.findByRole("button", { name: "Unarchive" });
    fireEvent.click(restoreButton);
    fireEvent.click(restoreButton);
    expect(unarchiveSession).toHaveBeenCalledOnce();
    await waitFor(() => expect((restoreButton as HTMLButtonElement).disabled).toBe(true));
    resolveRestore();
    await waitFor(() => expect((restoreButton as HTMLButtonElement).disabled).toBe(false));
  });

  it("filters archived tasks, saves retention, and refreshes active history after restore", async () => {
    const updateSettings = vi.fn(async () => ({ ...snapshot, archives: { archiveRetentionDays: 30 as const } }));
    const unarchiveSession = vi.fn(async () => undefined);
    const onSessionsChanged = vi.fn(async () => undefined);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      getSettings: async () => snapshot,
      updateSettings,
      listArchivedSessions: async () => [
        { id: "archive-1", model: "model-a", startedAtLocal: "today", messageCount: 2, firstUserPreview: "Refine archive controls", archivedAt: "2026-07-15T08:00:00.000Z" },
        { id: "archive-2", model: "model-a", startedAtLocal: "yesterday", messageCount: 3, firstUserPreview: "Other task", archivedAt: "2026-07-14T08:00:00.000Z" },
      ],
      unarchiveSession,
    } as unknown as RailgunDesktopApi });
    render(<SettingsPage backend={backend} agentRunning={false} scenarios={[]} onBack={vi.fn()} onDirtyChange={vi.fn()} onSaved={vi.fn()} onRetryBackend={vi.fn()} onSelectScenario={vi.fn()} onSessionsChanged={onSessionsChanged} />);
    await screen.findByText("Default model");
    fireEvent.click(screen.getByRole("button", { name: "Archived Tasks" }));
    expect(await screen.findByText("Refine archive controls")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search archived tasks" }), { target: { value: "other" } });
    expect(screen.queryByText("Refine archive controls")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    await waitFor(() => expect(unarchiveSession).toHaveBeenCalledWith("archive-2"));
    expect(onSessionsChanged).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("combobox", { name: "Archive retention" }));
    fireEvent.click(await screen.findByRole("option", { name: "30 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ section: "archives", archiveRetentionDays: 30 }));
  });

  it("searches descriptions, focuses a selected row, and confirms dirty navigation", async () => {
    const updateSettings = vi.fn(async () => snapshot);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      getSettings: async () => snapshot,
      updateSettings,
      signInDevin: async () => snapshot,
      signOutDevin: async () => snapshot,
      listSkills: async () => [],
      getSkill: async () => { throw new Error("unused"); },
    } as unknown as RailgunDesktopApi });
    render(<SettingsPage backend={backend} agentRunning={false} scenarios={[]} onBack={vi.fn()} onDirtyChange={vi.fn()} onSaved={vi.fn()} onRetryBackend={vi.fn()} onSelectScenario={vi.fn()} />);
    await screen.findByText("Default model");
    expect(screen.getByRole("heading", { name: "Railgun" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Knowledge" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "System" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.queryByRole("navigation", { name: "Knowledge destinations" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Skills", level: 1 })).toBeTruthy();
    expect(screen.getByText("Browse reusable instruction packages available to Railgun.")).toBeTruthy();
    expect(await screen.findByText("No skills installed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "General" }));

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
    render(<SettingsPage backend={backend} agentRunning={false} scenarios={[]} onBack={vi.fn()} onDirtyChange={vi.fn()} onSaved={vi.fn()} onRetryBackend={vi.fn()} onSelectScenario={vi.fn()} />);
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
    const callbacks = { onBack: vi.fn(), onDirtyChange: vi.fn(), onSaved: vi.fn(), onRetryBackend: vi.fn(), onSelectScenario: vi.fn() };
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
    const defaultModel = screen.getByRole("combobox", { name: /Default model/u });
    expect((defaultModel as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(defaultModel);
    expect(screen.getByRole("option", { name: "Model A" })).toBeTruthy();
  });

  it("waits for backend readiness before mounting Knowledge", async () => {
    const listSkills = vi.fn(async () => []);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      getSettings: async () => snapshot,
      updateSettings: async () => snapshot,
      signInDevin: async () => snapshot,
      signOutDevin: async () => snapshot,
      listSkills,
      getSkill: async () => { throw new Error("unused"); },
    } as unknown as RailgunDesktopApi });
    const callbacks = { onBack: vi.fn(), onDirtyChange: vi.fn(), onSaved: vi.fn(), onRetryBackend: vi.fn(), onSelectScenario: vi.fn() };
    const starting = { ...backend, phase: "starting" as const };
    const { rerender } = render(<SettingsPage backend={starting} agentRunning={false} scenarios={[]} {...callbacks} />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.getByText("Starting Railgun")).toBeTruthy();
    expect(listSkills).not.toHaveBeenCalled();

    rerender(<SettingsPage backend={backend} agentRunning={false} scenarios={[]} {...callbacks} />);
    expect(await screen.findByText("No skills installed")).toBeTruthy();
    expect(listSkills).toHaveBeenCalledOnce();
  });

  it("clears the instruction unload guard after a confirmed discard", async () => {
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      getSettings: async () => snapshot,
      updateSettings: async () => snapshot,
      signInDevin: async () => snapshot,
      signOutDevin: async () => snapshot,
      listInstructionFiles: async () => [{ id: "soul", label: "~/.railgun/SOUL.md", status: "active" }],
      getInstructionFile: async () => ({ id: "soul", label: "~/.railgun/SOUL.md", status: "active", content: "Original" }),
      updateInstructionFile: async () => ({ id: "soul", label: "~/.railgun/SOUL.md", status: "active", content: "Saved" }),
      listSkills: async () => [],
      getSkill: async () => { throw new Error("unused"); },
    } as unknown as RailgunDesktopApi });
    render(<SettingsPage backend={backend} agentRunning={false} scenarios={[]} onBack={vi.fn()} onDirtyChange={vi.fn()} onSaved={vi.fn()} onRetryBackend={vi.fn()} onSelectScenario={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Instructions" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Markdown instructions" }), { target: { value: "Changed" } });
    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(await screen.findByText("No skills installed")).toBeTruthy();
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it("allows valid IDs that match the retired select placeholders", async () => {
    const collisionSnapshot: SettingsSnapshot = {
      ...snapshot,
      models: [
        { ...snapshot.models[0]!, id: "__automatic__", name: "Automatic model ID" },
        { ...snapshot.models[0]!, id: "__choose__", name: "Choose model ID" },
      ],
      moaPresets: [{ name: "__off__", referenceModels: ["__automatic__"], aggregatorModel: "__choose__" }],
    };
    const updateSettings = vi.fn(async () => collisionSnapshot);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      getSettings: async () => collisionSnapshot,
      updateSettings,
      signInDevin: async () => collisionSnapshot,
      signOutDevin: async () => collisionSnapshot,
    } as unknown as RailgunDesktopApi });
    render(<SettingsPage backend={backend} agentRunning={false} scenarios={[]} onBack={vi.fn()} onDirtyChange={vi.fn()} onSaved={vi.fn()} onRetryBackend={vi.fn()} onSelectScenario={vi.fn()} />);

    fireEvent.click(await screen.findByRole("combobox", { name: "Default model" }));
    fireEvent.click(screen.getByRole("option", { name: "Automatic model ID" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ defaultModelId: "__automatic__" })));

    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Mixture of Agents preset" }));
    fireEvent.click(screen.getByRole("option", { name: "__off__" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ moaPreset: "__off__" })));

    fireEvent.click(screen.getByRole("button", { name: "Trust" }));
    fireEvent.click(screen.getByRole("radio", { name: "Smart" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Smart-review model" }));
    fireEvent.click(screen.getByRole("option", { name: "Choose model ID" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ reviewerModelId: "__choose__" })));
  });
});
