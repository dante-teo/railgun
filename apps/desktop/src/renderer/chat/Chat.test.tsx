// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSnapshot, DesktopAgentEvent, RailgunDesktopApi } from "../../shared/types";
import { ActivityInspector, Composer, Transcript, useChatController } from "./Chat";

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
  let interactionListener: ((request: import("../../shared/types").DesktopInteractionRequest) => void) | undefined;
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
    respondToApproval: async () => undefined,
    respondToClarification: async () => undefined,
    onInteractionRequest: next => { interactionListener = next; return () => undefined; },
    onAppCommand: () => () => undefined,
    ...overrides,
  };
  Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });
  return {
    api,
    emit: (event: DesktopAgentEvent) => listener?.(event),
    emitInteraction: (request: import("../../shared/types").DesktopInteractionRequest) => interactionListener?.(request),
  };
};

const Harness = (): React.JSX.Element => {
  const controller = useChatController(ready);
  return <><Transcript controller={controller} snapshot={ready} onRestart={async () => undefined} /><ActivityInspector activity={controller.state.activity} /><Composer controller={controller} available /><button>After composer</button></>;
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

  it("renders chronological accessible activity details, advisor severity, and MoA progress", () => {
    const bridge = makeApi();
    render(<Harness />);
    act(() => bridge.emit({ type: "tool-start", id: "a", name: "read_file", input: '{"path":"README.md"}' }));
    act(() => bridge.emit({ type: "tool-start", id: "b", name: "run_shell", input: "false" }));
    act(() => bridge.emit({ type: "tool-end", id: "b", name: "run_shell", failed: true, output: "exit 1" }));
    act(() => bridge.emit({ type: "moa-reference-start", index: 0, count: 1, model: "ref-model" }));
    act(() => bridge.emit({ type: "moa-reference-end", index: 0, model: "ref-model", preview: "reference idea" }));
    act(() => bridge.emit({ type: "moa-aggregating", model: "agg-model", refCount: 1 }));
    act(() => bridge.emit({ type: "assistant-delta", text: "answer" }));
    act(() => bridge.emit({ type: "assistant-complete" }));
    act(() => bridge.emit({ type: "advisor-note", severity: "blocker", text: "Tests are missing" }));

    expect(screen.queryByRole("heading", { name: "What are we building?" })).toBeNull();
    const disclosure = screen.getByRole("group", { name: "read_file — Running" });
    expect(disclosure).toBeTruthy();
    fireEvent.click(screen.getByText("read_file"));
    expect(screen.getByText(/README\.md/u)).toBeTruthy();
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText("Reference 1 of 1")).toBeTruthy();
    expect(screen.getByText("Aggregating 1 reference")).toBeTruthy();
    expect(screen.getByText("Aggregating 1 reference").parentElement?.textContent).toContain("Completed");
    expect(screen.getByText("Advisor blocker").closest(".advisor-row")?.className).toContain("blocker");
  });

  it("shows todo loading and replacement plus current-run subagent statuses, then clears on reset", () => {
    const bridge = makeApi();
    render(<Harness />);
    act(() => bridge.emit({ type: "run-start" }));
    act(() => bridge.emit({ type: "tool-start", id: "todo-1", name: "todo" }));
    act(() => bridge.emit({ type: "subagent-start", index: 0, count: 1, goal: "Inspect tests" }));
    expect(screen.getByRole("region", { name: "Agent activity inspector" })).toBeTruthy();
    expect(screen.getByText("Updating todos…")).toBeTruthy();
    expect(screen.getByText("Running", { selector: ".subagent-status" })).toBeTruthy();
    act(() => bridge.emit({ type: "tool-end", id: "todo-1", name: "todo", failed: false, todos: [{ id: "a", content: "Implement", status: "completed" }, { id: "b", content: "Verify", status: "in_progress" }] }));
    expect(screen.getByText("1 of 2 complete")).toBeTruthy();
    expect(screen.getByText("In progress")).toBeTruthy();
    act(() => bridge.emit({ type: "subagent-end", index: 0, goal: "Inspect tests", result: "Found coverage" }));
    expect(screen.getByText("Completed", { selector: ".subagent-status" })).toBeTruthy();
  });

  it("renders correlated approval and clarification prompts while locking the composer", async () => {
    const respondToApproval = vi.fn(async () => undefined);
    const respondToClarification = vi.fn(async () => undefined);
    const bridge = makeApi({ respondToApproval, respondToClarification });
    render(<Harness />);
    const textbox = screen.getByRole("textbox", { name: "Message Railgun" });
    fireEvent.change(textbox, { target: { value: "start" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    act(() => bridge.emitInteraction({ type: "approval", id: "11111111-1111-4111-8111-111111111111", command: "sudo safe-command" }));
    act(() => bridge.emitInteraction({ type: "clarification", id: "22222222-2222-4222-8222-222222222222", question: "Choose a path", choices: ["Fast", "Safe"] }));
    expect(screen.getByRole("region", { name: "Shell command approval" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Clarification request" })).toBeTruthy();
    expect(textbox).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", true));
    fireEvent.click(screen.getByRole("radio", { name: "Safe" }));
    await waitFor(() => expect(respondToClarification).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", "Safe"));
  });

  it("denies an approval when Escape is pressed", async () => {
    const respondToApproval = vi.fn(async () => undefined);
    const respondToClarification = vi.fn(async () => undefined);
    const bridge = makeApi({ respondToApproval, respondToClarification });
    render(<Harness />);
    const textbox = screen.getByRole("textbox", { name: "Message Railgun" });
    fireEvent.change(textbox, { target: { value: "start" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    act(() => bridge.emitInteraction({ type: "approval", id: "55555555-5555-4555-8555-555555555555", command: "sudo safe-command" }));

    fireEvent.keyDown(screen.getByRole("region", { name: "Shell command approval" }), { key: "Escape" });
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555", false));
    expect(respondToClarification).not.toHaveBeenCalled();
  });

  it("submits free text and uses Escape to decline clarification", async () => {
    const respondToClarification = vi.fn(async () => undefined);
    const bridge = makeApi({ respondToClarification });
    render(<Harness />);
    const textbox = screen.getByRole("textbox", { name: "Message Railgun" });
    fireEvent.change(textbox, { target: { value: "start" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    act(() => bridge.emitInteraction({ type: "clarification", id: "33333333-3333-4333-8333-333333333333", question: "What should I use?" }));
    const answer = screen.getByRole("textbox", { name: "Your answer" });
    fireEvent.change(answer, { target: { value: "the safe option" } });
    fireEvent.submit(answer.closest("form")!);
    await waitFor(() => expect(respondToClarification).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", "the safe option"));

    act(() => bridge.emitInteraction({ type: "clarification", id: "44444444-4444-4444-8444-444444444444", question: "Another answer?" }));
    fireEvent.keyDown(screen.getByRole("region", { name: "Clarification request" }), { key: "Escape" });
    await waitFor(() => expect(respondToClarification).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444", "[user declined to answer]"));
  });
});
