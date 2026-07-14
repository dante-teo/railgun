// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSnapshot, DesktopAgentEvent, RailgunDesktopApi } from "../../shared/types";
import { Composer, Transcript, useChatController } from "./Chat";

afterEach(cleanup);

const ready: BackendSnapshot = {
  mode: "mock",
  phase: "ready",
  scenarioId: "ready-idle",
  diagnostics: [],
  transportLog: [],
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const makeApi = (overrides: Partial<RailgunDesktopApi> = {}) => {
  let listener: ((event: DesktopAgentEvent) => void) | undefined;
  const api: RailgunDesktopApi = {
    getBackendSnapshot: async () => ready,
    restartBackend: async () => ready,
    onBackendSnapshot: () => () => undefined,
    listMockScenarios: async () => [],
    selectMockScenario: async () => ready,
    sendPrompt: async () => undefined,
    steerPrompt: async () => undefined,
    followUpPrompt: async () => undefined,
    abortPrompt: async () => undefined,
    openExternal: async () => undefined,
    startNewChat: async () => ready,
    onAgentEvent: next => { listener = next; return () => undefined; },
    onAppCommand: () => () => undefined,
    ...overrides,
  };
  Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });
  return { api, emit: (event: DesktopAgentEvent) => listener?.(event) };
};

const Harness = (): React.JSX.Element => {
  const controller = useChatController(ready);
  return <><Transcript controller={controller} snapshot={ready} onRestart={async () => undefined} /><Composer controller={controller} available /><button>After composer</button></>;
};

describe("chat composer", () => {
  it("sends on idle Enter and preserves Shift+Enter multiline input", async () => {
    const run = deferred<void>();
    const sendPrompt = vi.fn(() => run.promise);
    makeApi({ sendPrompt });
    render(<Harness />);
    const textbox = screen.getByRole("textbox", { name: "Message Railgun" });
    fireEvent.change(textbox, { target: { value: "first\nsecond" } });
    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
    expect((textbox as HTMLTextAreaElement).value).toBe("first\nsecond");
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("first\nsecond"));
    expect(document.querySelector(".message.user > p")?.textContent).toBe("first\nsecond");
    run.resolve();
  });

  it("queues steering and follow-up, preserves rejected drafts, and injects queue boundaries", async () => {
    const run = deferred<void>();
    const steerPrompt = vi.fn(async () => undefined);
    const followUpPrompt = vi.fn()
      .mockRejectedValueOnce(new Error("follow-up rejected"))
      .mockResolvedValueOnce(undefined);
    const bridge = makeApi({ sendPrompt: () => run.promise, steerPrompt, followUpPrompt });
    render(<Harness />);
    const textbox = screen.getByRole("textbox", { name: "Message Railgun" });
    fireEvent.change(textbox, { target: { value: "start" } });
    fireEvent.keyDown(textbox, { key: "Enter" });

    fireEvent.change(textbox, { target: { value: "steer now" } });
    expect(fireEvent.keyDown(textbox, { key: "Enter" })).toBe(false);
    await screen.findByText("Steering");
    expect(steerPrompt).toHaveBeenCalledWith("steer now");

    fireEvent.change(textbox, { target: { value: "later" } });
    expect(fireEvent.keyDown(textbox, { key: "Tab" })).toBe(false);
    expect((await screen.findByRole("alert")).textContent).toContain("follow-up rejected");
    expect((textbox as HTMLTextAreaElement).value).toBe("later");
    fireEvent.keyDown(textbox, { key: "Tab" });
    await screen.findByText("Follow-up");

    act(() => bridge.emit({ type: "queue-update", steering: [], followUp: ["later"] }));
    await waitFor(() => expect(screen.queryByText("steer now")).toBeTruthy());
    expect(screen.getAllByText("steer now")).toHaveLength(1);

    fireEvent.change(textbox, { target: { value: "" } });
    expect(fireEvent.keyDown(textbox, { key: "Tab" })).toBe(true);
    act(() => bridge.emit({ type: "run-end" }));
    expect(screen.queryByRole("region", { name: "Queued messages" })).toBeNull();
    run.resolve();
  });

  it("prevents duplicate stops and waits for run-end before settling partial output", async () => {
    const first = deferred<void>();
    const abort = deferred<void>();
    const sendPrompt = vi.fn(() => first.promise);
    const abortPrompt = vi.fn(() => abort.promise);
    const bridge = makeApi({ sendPrompt, abortPrompt });
    render(<Harness />);
    const textbox = screen.getByRole("textbox", { name: "Message Railgun" });
    fireEvent.change(textbox, { target: { value: "request" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    act(() => bridge.emit({ type: "assistant-delta", text: "partial" }));
    fireEvent.change(textbox, { target: { value: "queued" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    await screen.findByText("Queued");
    const stop = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    fireEvent.click(stop);
    expect(abortPrompt).toHaveBeenCalledOnce();
    await act(async () => abort.resolve());
    expect(screen.queryByRole("region", { name: "Queued messages" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

    act(() => bridge.emit({ type: "assistant-delta", text: " output" }));
    act(() => bridge.emit({ type: "run-end" }));
    expect(screen.getByText("partial output")).toBeTruthy();
    expect(document.querySelector(".message.assistant")?.getAttribute("data-status")).toBe("stopped");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    first.resolve();
  });

  it("retries a failed initial prompt without duplicating the user", async () => {
    const sendPrompt = vi.fn()
      .mockRejectedValueOnce(new Error("request failed"))
      .mockResolvedValueOnce(undefined);
    makeApi({ sendPrompt });
    render(<Harness />);
    const textbox = screen.getByRole("textbox", { name: "Message Railgun" });
    fireEvent.change(textbox, { target: { value: "request" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getAllByText("request")).toHaveLength(1);
    fireEvent.click(retry);
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("request")).toHaveLength(1);
  });
});
