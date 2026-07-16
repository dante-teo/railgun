// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatControlsSnapshot, DesktopAgentEvent, RailgunDesktopApi } from "../../shared/types";
import { ChatToolbarControls, formatContextUsage } from "./ChatControls";

afterEach(cleanup);

const controls: ChatControlsSnapshot = {
  models: [
    { id: "model-a", name: "Alpha", inputs: ["text"], supportsTools: true, reasoning: false, contextWindow: 200_000, maxOutputTokens: 8_000 },
    { id: "model-b", name: "Beta Vision", inputs: ["text", "image"], supportsTools: true, reasoning: true, contextWindow: 100_000, maxOutputTokens: 4_000 },
  ],
  activeModelId: "model-a", defaultModelId: null, messageCount: 2,
  moaPresets: [{ name: "review", referenceModels: ["model-b"], aggregatorModel: "model-a" }],
  activeMoaPreset: null, advisor: { enabled: false, modelId: "model-b" }, contextWindow: 200_000,
};

const makeApi = (overrides: Partial<RailgunDesktopApi> = {}) => {
  let listener: ((event: DesktopAgentEvent) => void) | undefined;
  const mutation = async () => ({ controls, persistence: "saved" as const });
  const api = {
    getChatControls: async () => controls,
    setChatModel: mutation,
    updateAgentControls: mutation,
    compactContext: mutation,
    onAgentEvent: (next: (event: DesktopAgentEvent) => void) => { listener = next; return () => undefined; },
    ...overrides,
  } as RailgunDesktopApi;
  Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });
  return { api, emit: (event: DesktopAgentEvent) => listener?.(event) };
};

describe("chat toolbar controls", () => {
  it("formats exact provider usage and unknown states", () => {
    expect(formatContextUsage(undefined, 200_000)).toBe("Not measured yet");
    expect(formatContextUsage({ inputTokens: 100_000, outputTokens: 50_000 }, 200_000)).toBe("150,000 / 200,000 tokens (75%)");
  });

  it("uses frameless composer dropdown triggers", async () => {
    makeApi();
    render(<ChatToolbarControls running={false} available resetKey={0} />);

    for (const name of ["Choose model", "Agent settings"]) {
      const trigger = await screen.findByRole("button", { name });
      expect(trigger.className).toContain("bg-transparent");
      expect(trigger.className).toContain("border-transparent");
      expect(trigger.className).not.toContain("bg-secondary");
    }
  });

  it("searches models with keyboard selection and an explicit persistence choice", async () => {
    const setChatModel = vi.fn(async () => ({ controls: { ...controls, activeModelId: "model-b", contextWindow: 100_000 }, persistence: "session-only" as const }));
    makeApi({ setChatModel });
    render(<ChatToolbarControls running={false} available resetKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose model" }));
    const search = screen.getByRole("combobox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "vision" } });
    expect(screen.getByRole("option", { name: /Beta Vision/u })).toBeTruthy();
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "This task" }));
    await waitFor(() => expect(setChatModel).toHaveBeenCalledWith("model-b", "chat"));
  });

  it("starts keyboard navigation on the active model", async () => {
    const activeControls = { ...controls, activeModelId: "model-b" };
    const setChatModel = vi.fn(async () => ({ controls: activeControls, persistence: "session-only" as const }));
    makeApi({ getChatControls: async () => activeControls, setChatModel });
    render(<ChatToolbarControls running={false} available resetKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose model" }));
    const search = screen.getByRole("combobox", { name: "Search models" });

    expect(search.getAttribute("aria-activedescendant")).toBe("model-option-1");
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "This task" }));

    await waitFor(() => expect(setChatModel).toHaveBeenCalledWith("model-b", "chat"));
  });

  it("does not apply a model hidden by a search until the user selects a visible result", async () => {
    const setChatModel = vi.fn(async () => ({ controls, persistence: "session-only" as const }));
    makeApi({ setChatModel });
    render(<ChatToolbarControls running={false} available resetKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose model" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), { target: { value: "vision" } });

    expect(screen.getByRole("button", { name: "This task" })).toHaveProperty("disabled", true);
    expect(setChatModel).not.toHaveBeenCalled();
  });

  it("keeps the model empty state outside the listbox", async () => {
    makeApi();
    render(<ChatToolbarControls running={false} available resetKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose model" }));
    const search = screen.getByRole("combobox", { name: "Search models" });
    expect(search.getAttribute("aria-autocomplete")).toBe("list");
    fireEvent.change(search, { target: { value: "missing model" } });

    const listbox = screen.getByRole("listbox", { name: "Available models" });
    expect(listbox.children).toHaveLength(0);
    expect(screen.getByText(/No models match/u).closest("[role='listbox']")).toBeNull();
  });

  it("reports unavailable controls instead of remaining in a loading state", () => {
    makeApi();
    render(<ChatToolbarControls running={false} available={false} resetKey={0} />);
    expect(screen.getByText("Controls unavailable")).toBeTruthy();
    expect(screen.queryByText("Loading controls…")).toBeNull();
  });

  it("updates exact usage, handles compaction resets, and disables incompatible model operations", async () => {
    const bridge = makeApi();
    const view = render(<ChatToolbarControls running={false} available resetKey={0} />);
    await screen.findByRole("button", { name: "Choose model" });
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
    act(() => bridge.emit({ type: "context-usage", inputTokens: 100_000, outputTokens: 50_000 }));
    expect(screen.getByText(/75%/u)).toBeTruthy();
    act(() => bridge.emit({ type: "context-reset", reason: "compaction" }));
    expect(screen.getByText("Not measured yet")).toBeTruthy();

    view.rerender(<ChatToolbarControls running available resetKey={0} />);
    expect(screen.getByRole("button", { name: "Choose model" })).toHaveProperty("disabled", true);
  });

  it("keeps the model dialog open with a retryable inline mutation error", async () => {
    makeApi({ setChatModel: async () => { throw new Error("selection rejected"); } });
    render(<ChatToolbarControls running={false} available resetKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose model" }));
    fireEvent.click(screen.getByRole("option", { name: /Beta Vision/u }));
    fireEvent.click(screen.getByRole("button", { name: "Make default" }));
    expect((await screen.findByRole("alert")).textContent).toContain("selection rejected");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("exposes compaction in agent settings, resets usage after success, and disables empty history", async () => {
    const compactContext = vi.fn(async () => ({ controls, persistence: "session-only" as const }));
    const bridge = makeApi({ compactContext });
    render(<ChatToolbarControls running={false} available resetKey={0} />);
    await screen.findByRole("button", { name: "Agent settings" });
    act(() => bridge.emit({ type: "context-usage", inputTokens: 100_000, outputTokens: 50_000 }));
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Agent settings" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Compact context" }));
    await waitFor(() => expect(compactContext).toHaveBeenCalledOnce());
    expect(screen.getByText("Not measured yet")).toBeTruthy();

    cleanup();
    makeApi({ getChatControls: async () => ({ ...controls, messageCount: 0 }) });
    render(<ChatToolbarControls running={false} available resetKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agent settings" }));
    expect(screen.getByRole("button", { name: "Compact context" })).toHaveProperty("disabled", true);
  });

  it("preserves context usage across resetKey changes", async () => {
    const bridge = makeApi();
    const view = render(<ChatToolbarControls running={false} available resetKey={0} />);
    await screen.findByRole("button", { name: "Choose model" });
    act(() => bridge.emit({ type: "context-usage", inputTokens: 80_000, outputTokens: 20_000 }));
    expect(screen.getByText(/50%/u)).toBeTruthy();
    view.rerender(<ChatToolbarControls running={false} available resetKey={1} />);
    expect(screen.getByText(/50%/u)).toBeTruthy();
  });
});
