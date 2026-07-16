// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { OverlayScrollbars } from "overlayscrollbars";
import type { BackendSnapshot, DesktopAgentEvent, RailgunDesktopApi } from "../../shared/types";
import { ActivityDashboard, collapseCompletedTurnActivity, Composer, groupConsecutiveToolActivities, toolActivityGroupKey, Transcript, transcriptActiveDashIndexes, transcriptIndicatorDashCount, transcriptIsAtBottom, transcriptScrollProgress, useChatController, WorkedActivityGroup } from "./Chat";

Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} });

const overlayHarness = vi.hoisted(() => ({
  clientHeight: 0,
  scrollHeight: 0,
  element: undefined as HTMLElement | undefined,
}));

vi.mock("overlayscrollbars-react", async () => {
  const React = await import("react");
  type Events = Readonly<{
    initialized?: (instance: OverlayScrollbars) => void;
    updated?: (instance: OverlayScrollbars, event: unknown) => void;
    scroll?: (instance: OverlayScrollbars, event: Event) => void;
  }>;
  return {
    OverlayScrollbarsComponent: ({ children, className, events }: {
      readonly children: ReactNode;
      readonly className?: string;
      readonly events?: Events;
    }) => {
      const elementRef = React.useRef<HTMLDivElement>(null);
      const instanceRef = React.useRef<OverlayScrollbars | undefined>(undefined);
      const initializedRef = React.useRef(false);
      if (instanceRef.current === undefined) {
        instanceRef.current = {
          elements: () => ({ scrollOffsetElement: elementRef.current }),
        } as unknown as OverlayScrollbars;
      }
      React.useLayoutEffect(() => {
        const element = elementRef.current;
        const instance = instanceRef.current;
        if (element === null || instance === undefined) return;
        Object.defineProperties(element, {
          clientHeight: { configurable: true, get: () => overlayHarness.clientHeight },
          scrollHeight: { configurable: true, get: () => overlayHarness.scrollHeight },
        });
        overlayHarness.element = element;
        if (initializedRef.current) events?.updated?.(instance, undefined);
        else {
          initializedRef.current = true;
          events?.initialized?.(instance);
        }
      });
      return <div
        className={className}
        data-testid="transcript-scroll"
        ref={elementRef}
        onScroll={event => {
          const instance = instanceRef.current;
          if (instance !== undefined) events?.scroll?.(instance, event.nativeEvent);
        }}
      >{children}</div>;
    },
  };
});

afterEach(cleanup);

beforeEach(() => {
  overlayHarness.clientHeight = 0;
  overlayHarness.scrollHeight = 0;
  overlayHarness.element = undefined;
});

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
    listMemories: async () => [],
    createMemory: async value => ({ id: "memory", ...value, createdAt: 1 }),
    updateMemory: async (id, value) => ({ id, ...value, createdAt: 1 }),
    deleteMemory: async () => undefined,
    importNotes: async () => ({ cancelled: true }),
    searchNotes: async () => [],
    runDream: async () => ({ status: "skipped", beforeCount: 0, afterCount: 0 }),
    onDreamProgress: () => () => undefined,
    listInstructionFiles: async () => [],
    getInstructionFile: async () => { throw new Error("unused"); },
    updateInstructionFile: async () => { throw new Error("unused"); },
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
    listFiles: async () => ({ entries: [] }),
    previewFile: async () => ({ kind: "text", text: "" }),
    revealFile: async () => undefined,
    listCronJobs: async () => [],
    createCronJob: async (input) => ({ id: "cron", summary: "Every day", ...input }),
    updateCronJob: async (id, input) => ({ id, summary: "Every day", ...input }),
    deleteCronJob: async () => undefined,
    getAutomationStatus: async () => ({ state: "disabled", enabled: false, scheduler: "stopped", dream: "stopped", message: "Background automation is off." }),
    enableAutomation: async () => ({ state: "enabled", enabled: true, scheduler: "running", dream: "waiting", message: "Enabled" }),
    disableAutomation: async () => ({ state: "disabled", enabled: false, scheduler: "stopped", dream: "stopped", message: "Disabled" }),
    repairAutomation: async () => ({ state: "enabled", enabled: true, scheduler: "running", dream: "waiting", message: "Repaired" }),
    startNewChat: async () => ({ id: "mock", startedAt: "2026-07-14T09:00:00.000Z", model: "mock-model", messageCount: 0, running: false, checkpoint: { state: "unsaved" }, transcript: [], todos: [] }),
    listSessions: async () => [],
    listArchivedSessions: async () => [],
    archiveSession: async () => ({ id: "mock", startedAt: "2026-07-14T09:00:00.000Z", model: "mock-model", messageCount: 0, running: false, checkpoint: { state: "unsaved" }, transcript: [], todos: [] }),
    unarchiveSession: async () => undefined,
    resumeSession: async () => ({ id: "mock", startedAt: "2026-07-14T09:00:00.000Z", model: "mock-model", messageCount: 0, running: false, checkpoint: { state: "unsaved" }, transcript: [], todos: [] }),
    branchSession: async () => ({ id: "mock", startedAt: "2026-07-14T09:00:00.000Z", model: "mock-model", messageCount: 0, running: false, checkpoint: { state: "unsaved" }, transcript: [], todos: [] }),
    forkSession: async () => ({ id: "mock", startedAt: "2026-07-14T09:00:00.000Z", model: "mock-model", messageCount: 0, running: false, checkpoint: { state: "unsaved" }, transcript: [], todos: [] }),
    showSessionContextMenu: async () => null,
    onSessionSnapshot: () => () => undefined,
    getChatControls: async () => ({ models: [], activeModelId: "mock-model", defaultModelId: null, messageCount: 0, moaPresets: [], activeMoaPreset: null, advisor: { enabled: false, modelId: null }, contextWindow: null }),
    setChatModel: async () => { throw new Error("unused"); },
    updateAgentControls: async () => { throw new Error("unused"); },
    compactContext: async () => { throw new Error("unused"); },
    getSettings: async () => { throw new Error("unused"); },
    updateSettings: async () => { throw new Error("unused"); },
    signInDevin: async () => { throw new Error("unused"); },
    signOutDevin: async () => { throw new Error("unused"); },
    listSkills: async () => [],
    getSkill: async (name: string) => ({ name, description: "Test", disableModelInvocation: false, body: "# Test" }),
    listMcpServers: async () => [],
    upsertMcpServer: async () => [],
    removeMcpServer: async () => [],
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
  return <><Transcript controller={controller} snapshot={ready} onRestart={async () => undefined} /><ActivityDashboard activity={controller.state.activity} /><Composer controller={controller} available /><button>After composer</button></>;
};

describe("chat renderer", () => {
  it("groups only consecutive uses of the same tool", () => {
    const grouped = groupConsecutiveToolActivities([
      { kind: "tool", id: "one", name: "write_file", status: "success", order: 1 },
      { kind: "tool", id: "two", name: "write_file", status: "success", order: 2 },
      { kind: "tool", id: "read", name: "read_file", status: "success", order: 3 },
      { kind: "tool", id: "three", name: "write_file", status: "success", order: 4 },
      { kind: "moa-aggregation", id: "aggregate", model: "mock", refCount: 1, status: "success", order: 5 },
      { kind: "tool", id: "four", name: "write_file", status: "success", order: 6 },
      { kind: "tool", id: "five", name: "write_file", status: "success", order: 7 },
    ]);

    expect(grouped).toHaveLength(5);
    expect(grouped[0]).toMatchObject({ kind: "tool-group", name: "write_file", entries: [{ id: "one" }, { id: "two" }] });
    expect(grouped[1]).toMatchObject({ kind: "tool", id: "read" });
    expect(grouped[2]).toMatchObject({ kind: "tool", id: "three" });
    expect(grouped[4]).toMatchObject({ kind: "tool-group", name: "write_file", entries: [{ id: "four" }, { id: "five" }] });
  });

  it("keeps merged activity active while one of its tool uses is still running", () => {
    expect(groupConsecutiveToolActivities([
      { kind: "tool", id: "failed", name: "write_file", status: "error", order: 1 },
      { kind: "tool", id: "active", name: "write_file", status: "running", order: 2 },
    ])).toMatchObject([{ kind: "tool-group", status: "running" }]);
  });

  it("uses tool name and invocation order to uniquely key merged activity rows", () => {
    const groups = groupConsecutiveToolActivities([
      { kind: "tool", id: "a", name: "write_file", status: "success", order: 10 },
      { kind: "tool", id: "b", name: "write_file", status: "success", order: 11 },
      { kind: "moa-aggregation", id: "boundary", model: "mock", refCount: 1, status: "success", order: 12 },
      { kind: "tool", id: "a", name: "write_file", status: "success", order: 20 },
      { kind: "tool", id: "b", name: "write_file", status: "success", order: 21 },
    ]).filter(entry => entry.kind === "tool-group");

    expect(groups.map(toolActivityGroupKey)).toEqual(["tool-group-write_file-10-11", "tool-group-write_file-20-21"]);
  });

  it("collapses successful turn activity until its final response", () => {
    const entries = [
      { kind: "message" as const, order: 1, message: { id: "user", role: "user" as const, text: "Fix sync", status: "complete" as const, order: 1, startedAt: 10_000 } },
      { kind: "activity" as const, order: 2, activity: { kind: "tool" as const, id: "list", name: "list_directory", status: "success" as const, order: 2 } },
      { kind: "activity" as const, order: 3, activity: { kind: "tool" as const, id: "read", name: "read_file", status: "error" as const, order: 3 } },
      { kind: "message" as const, order: 4, message: { id: "assistant", role: "assistant" as const, text: "Fixed and verified.", status: "complete" as const, order: 4, completedAt: 31_000 } },
    ];

    const collapsed = collapseCompletedTurnActivity(entries, false);
    expect(collapsed).toHaveLength(3);
    expect(collapsed[1]).toMatchObject({ kind: "worked", durationMs: 21_000, activities: [expect.objectContaining({ name: "list_directory" }), expect.objectContaining({ name: "read_file" })] });
    expect(collapseCompletedTurnActivity(entries, true)).toHaveLength(4);

    const completedTurns = collapseCompletedTurnActivity([...entries,
      { kind: "message" as const, order: 5, message: { id: "user-2", role: "user" as const, text: "Verify UI", status: "complete" as const, order: 5, startedAt: 40_000 } },
      { kind: "activity" as const, order: 6, activity: { kind: "tool" as const, id: "test", name: "run_shell_command", status: "success" as const, order: 6 } },
      { kind: "message" as const, order: 7, message: { id: "assistant-2", role: "assistant" as const, text: "All checks pass.", status: "complete" as const, order: 7, completedAt: 45_000 } },
    ], false);
    expect(completedTurns.filter(item => item.kind === "entry" && item.entry.kind === "activity")).toEqual([]);
  });

  it("keeps completed work collapsed until the user expands it", () => {
    const { container } = render(<WorkedActivityGroup durationMs={21_000} activities={[
      { kind: "tool", id: "list", name: "list_directory", status: "success", order: 1 },
    ]} />);
    const details = container.querySelector("details");

    expect(screen.getByText("Worked for 21s")).toBeTruthy();
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Worked for 21s"));
    expect(details?.open).toBe(true);
  });

  it("keeps tool activity from mixed restored assistant messages inside the completed turn", () => {
    const collapsed = collapseCompletedTurnActivity([
      { kind: "message", order: 1, message: { id: "user", role: "user", text: "Inspect sync", status: "complete", order: 1, messageId: 10 } },
      { kind: "message", order: 2, message: { id: "progress", role: "assistant", text: "I found the files.", status: "complete", order: 2, messageId: 11 } },
      { kind: "activity", order: 3, activity: { kind: "tool", id: "read", name: "read_file", status: "success", order: 3 } },
      { kind: "activity", order: 4, activity: { kind: "tool", id: "test", name: "run_shell_command", status: "error", order: 4 } },
      { kind: "message", order: 5, message: { id: "final", role: "assistant", text: "Fixed.", status: "complete", order: 5, messageId: 14, branchable: true } },
    ], false);

    expect(collapsed.filter(item => item.kind === "entry" && item.entry.kind === "activity")).toEqual([]);
    expect(collapsed.find(item => item.kind === "worked")).toMatchObject({ activities: [expect.objectContaining({ name: "read_file" }), expect.objectContaining({ name: "run_shell_command" })] });
  });

  it("distinguishes messages without redundant speaker labels", () => {
    const bridge = makeApi();
    const { container } = render(<Harness />);
    const textbox = screen.getByRole("textbox", { name: "Message Railgun" });

    fireEvent.change(textbox, { target: { value: "request" } });
    fireEvent.keyDown(textbox, { key: "Enter" });
    act(() => {
      bridge.emit({ type: "assistant-delta", text: "response" });
      bridge.emit({ type: "assistant-complete" });
    });

    expect(container.querySelectorAll(".message")).toHaveLength(2);
    expect(container.querySelector(".message-role")).toBeNull();
    expect(container.querySelector<HTMLElement>(".message")?.className).toContain("w-full");
    expect(container.querySelector<HTMLElement>(".message")?.className).toContain("max-w-content");
  });

  it("hides transcript position dashes when there is no overflow", () => {
    makeApi();
    const { container } = render(<Harness />);

    expect(container.querySelector(".transcript-scroll-indicator")).toBeNull();
    expect(container.querySelector(".transcript-content")?.getAttribute("aria-live")).toBe("polite");
  });

  it("centers the transcript and composer symmetrically within the available shell width", () => {
    makeApi();
    const { container } = render(<Harness />);
    const transcript = container.querySelector<HTMLElement>(".transcript-content");
    const composer = screen.getByRole("textbox", { name: "Message Railgun" })
      .closest<HTMLElement>(".col-start-1.row-start-1");
    const composerContent = screen.getByRole("textbox", { name: "Message Railgun" })
      .closest<HTMLElement>(".max-w-content");
    const textbox = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message Railgun" });

    expect(transcript?.className).not.toContain("--active-sidebar-inset");
    expect(transcript?.className).toContain("pl-[var(--transcript-content-left-base)]");
    expect(transcript?.className).not.toContain("calc((100%_-_var(--container-content))/2)");
    expect(composer?.className).not.toContain("--active-sidebar-inset");
    expect(composer?.className).toContain("px-7");
    expect(composer?.className).not.toContain("calc((100%_-_var(--container-content))/2)");
    expect(composer?.className).toContain("h-fit");
    expect(composerContent?.className).toContain("w-full");
    expect(textbox.rows).toBe(1);
    expect(textbox.className).toContain("[field-sizing:content]");
    expect(textbox.className).toContain("max-h-[calc(10lh+var(--space-4)+2px)]");
    expect(textbox.className).toContain("resize-none");
    expect(textbox.className).not.toContain("resize-y");
    const send = screen.getByRole("button", { name: "Send" });
    const sendIcon = send.querySelector(".lucide-send");
    expect(send.parentElement?.className).toContain("mt-3");
    expect(send.className).toContain("justify-center");
    expect(send.className).toContain("rounded-full");
    expect(sendIcon?.classList.contains("-translate-x-px")).toBe(true);
    expect(sendIcon?.classList.contains("translate-y-px")).toBe(true);
    expect(container.innerHTML).not.toContain("--content-width");
  });

  it("grows the transcript position rail with overflow up to its maximum", () => {
    expect(transcriptIndicatorDashCount({ scrollTop: 0, scrollHeight: 500, clientHeight: 500 })).toBe(0);
    expect(transcriptIndicatorDashCount({ scrollTop: 0, scrollHeight: 501, clientHeight: 500 })).toBe(4);
    expect(transcriptIndicatorDashCount({ scrollTop: 0, scrollHeight: 596, clientHeight: 500 })).toBe(5);
    expect(transcriptIndicatorDashCount({ scrollTop: 0, scrollHeight: 10_000, clientHeight: 500 })).toBe(24);

    overlayHarness.clientHeight = 500;
    overlayHarness.scrollHeight = 501;
    makeApi();
    const { container } = render(<Harness />);
    const indicator = container.querySelector(".transcript-scroll-indicator");
    expect(indicator?.children).toHaveLength(4);
    expect(indicator?.querySelectorAll(".active")).toHaveLength(4);
  });

  it("maps scroll progress onto the same dash elements", () => {
    expect(transcriptActiveDashIndexes(-1)).toEqual([0, 1, 2, 3]);
    expect(transcriptActiveDashIndexes(0)).toEqual([0, 1, 2, 3]);
    expect(transcriptActiveDashIndexes(0.5)).toEqual([10, 11, 12, 13]);
    expect(transcriptActiveDashIndexes(1)).toEqual([20, 21, 22, 23]);
    expect(transcriptActiveDashIndexes(2)).toEqual([20, 21, 22, 23]);
    expect(transcriptActiveDashIndexes(0, 4)).toEqual([0, 1, 2, 3]);
    expect(transcriptActiveDashIndexes(1, 5)).toEqual([1, 2, 3, 4]);
  });

  it("calculates bounded transcript progress from scroll metrics", () => {
    expect(transcriptScrollProgress({ scrollTop: 250, scrollHeight: 1_000, clientHeight: 500 })).toBe(0.5);
    expect(transcriptScrollProgress({ scrollTop: 0, scrollHeight: 500, clientHeight: 500 })).toBe(0);
    expect(transcriptScrollProgress({ scrollTop: 800, scrollHeight: 1_000, clientHeight: 500 })).toBe(1);
  });

  it("detects the transcript bottom with non-scrollable content and a 4px tolerance", () => {
    expect(transcriptIsAtBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 500 })).toBe(true);
    expect(transcriptIsAtBottom({ scrollTop: 496, scrollHeight: 1_000, clientHeight: 500 })).toBe(true);
    expect(transcriptIsAtBottom({ scrollTop: 495.9, scrollHeight: 1_000, clientHeight: 500 })).toBe(false);
  });

  it("mounts a long transcript at the bottom", () => {
    overlayHarness.clientHeight = 500;
    overlayHarness.scrollHeight = 1_000;
    makeApi();
    render(<Harness />);

    expect(overlayHarness.element?.scrollTop).toBe(500);
  });

  it("keeps streaming content updates pinned while follow mode is active", () => {
    overlayHarness.clientHeight = 500;
    overlayHarness.scrollHeight = 1_000;
    const bridge = makeApi();
    render(<Harness />);

    overlayHarness.scrollHeight = 1_200;
    act(() => {
      bridge.emit({ type: "assistant-delta", text: "streaming output" });
      bridge.emit({ type: "run-end" });
    });

    expect(overlayHarness.element?.scrollTop).toBe(700);
  });

  it("does not treat repeated delayed automatic scroll events as leaving the bottom", () => {
    overlayHarness.clientHeight = 500;
    overlayHarness.scrollHeight = 1_000;
    const bridge = makeApi();
    render(<Harness />);
    const scroller = screen.getByTestId("transcript-scroll");

    overlayHarness.scrollHeight = 1_200;
    act(() => bridge.emit({ type: "tool-start", id: "first", name: "first update" }));
    expect(scroller.scrollTop).toBe(700);

    overlayHarness.scrollHeight = 1_400;
    act(() => {
      fireEvent.scroll(scroller);
      fireEvent.scroll(scroller);
    });
    act(() => bridge.emit({ type: "tool-start", id: "second", name: "second update" }));
    expect(scroller.scrollTop).toBe(900);
  });

  it("preserves position after any non-automatic scroll away from the bottom", () => {
    overlayHarness.clientHeight = 500;
    overlayHarness.scrollHeight = 1_000;
    const bridge = makeApi();
    render(<Harness />);
    const scroller = screen.getByTestId("transcript-scroll");

    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);
    overlayHarness.scrollHeight = 1_200;
    act(() => bridge.emit({ type: "tool-start", id: "first", name: "first update" }));
    expect(scroller.scrollTop).toBe(200);
  });

  it("resumes following after returning to the bottom", () => {
    overlayHarness.clientHeight = 500;
    overlayHarness.scrollHeight = 1_200;
    const bridge = makeApi();
    render(<Harness />);
    const scroller = screen.getByTestId("transcript-scroll");

    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);
    scroller.scrollTop = 700;
    fireEvent.scroll(scroller);
    overlayHarness.scrollHeight = 1_400;
    act(() => bridge.emit({ type: "tool-start", id: "second", name: "second update" }));
    expect(scroller.scrollTop).toBe(900);
  });

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

  it("renders compact tool activity and MoA progress while keeping advisor notes out of the transcript", () => {
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
    expect(screen.getByText("Reading")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(disclosure.className).toContain("tool-row");
    expect(disclosure.className).toContain("opacity-100");
    expect(disclosure.className).not.toContain("opacity-55");
    expect(disclosure.className).toContain("focus-within:opacity-100");
    expect(disclosure.className).toContain("hover:opacity-100");
    expect(disclosure.className).toContain("open:opacity-100");
    expect(disclosure.querySelector("summary")?.className).not.toContain("opacity-55");
    expect(disclosure.querySelector(".tool-activity-icon svg")).toBeTruthy();
    fireEvent.click(screen.getByText("Reading"));
    expect(screen.getAllByText(/README\.md/u)).toHaveLength(2);
    const failedDisclosure = screen.getByRole("group", { name: "run_shell — Error" });
    expect(failedDisclosure.className).toContain("opacity-100");
    expect(failedDisclosure.className).not.toContain("opacity-55");
    expect(screen.getByText("Reference 1 of 1")).toBeTruthy();
    expect(screen.getByText("Aggregating 1 reference")).toBeTruthy();
    expect(screen.getByText("Aggregating 1 reference").parentElement?.textContent).toContain("Completed");
    expect(screen.getByRole("region", { name: "Activity Dashboard" })).toBeTruthy();
    expect(screen.queryByText("Advisor blocker")).toBeNull();
    expect(screen.queryByText("Tests are missing")).toBeNull();
  });

  it("merges consecutive tool rows into an expandable parameter-free summary", () => {
    const bridge = makeApi();
    render(<Harness />);
    act(() => bridge.emit({ type: "tool-start", id: "first", name: "write_file", input: '{"path":"src/one.ts"}' }));
    act(() => bridge.emit({ type: "tool-start", id: "second", name: "write_file", input: '{"path":"src/two.ts"}' }));
    act(() => bridge.emit({ type: "tool-end", id: "first", name: "write_file", failed: false }));
    act(() => bridge.emit({ type: "tool-end", id: "second", name: "write_file", failed: false }));

    const summary = screen.getByRole("group", { name: "Edited files — 2 tool uses" }) as HTMLDetailsElement;
    const summaryTrigger = summary.querySelector("summary");
    const chevron = summary.querySelector(".tool-activity-group-chevron.lucide-chevron-right");
    expect(summary.className).toContain("group/tool-group");
    expect(summary.className).toContain("opacity-55");
    expect(summary.className).toContain("focus-within:opacity-100");
    expect(summary.className).toContain("hover:opacity-100");
    expect(summary.className).toContain("open:opacity-100");
    expect(summaryTrigger?.textContent).toBe("Edited files");
    expect(summaryTrigger?.className).not.toContain("opacity-55");
    expect(chevron).toBeTruthy();
    expect(chevron?.getAttribute("class")).toContain("group-open/tool-group:rotate-90");
    expect(chevron?.getAttribute("class")).not.toContain("invisible");
    expect(chevron?.getAttribute("class")).not.toContain("group-open:rotate-90");
    expect(summaryTrigger?.nextElementSibling?.className).toContain("pl-7");
    expect(summary.open).toBe(false);
    fireEvent.click(screen.getByText("Edited files"));
    expect(summary.open).toBe(true);
    expect(screen.getAllByRole("group", { name: "write_file — Completed" })).toHaveLength(2);
    expect(screen.getAllByText("Edited")).toHaveLength(2);
  });

  it("shows the Activity Dashboard in Advisor, Todo, Subagents order with agent detail popovers and run lifecycle updates", () => {
    const bridge = makeApi();
    render(<Harness />);
    act(() => bridge.emit({ type: "run-start" }));
    act(() => bridge.emit({ type: "tool-start", id: "todo-1", name: "todo" }));
    act(() => bridge.emit({ type: "subagent-start", index: 0, count: 1, goal: "Inspect tests" }));
    expect(screen.getByRole("region", { name: "Activity Dashboard" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Todos" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Subagents" })).toBeTruthy();
    expect(screen.getByText("Updating todos…")).toBeTruthy();
    const subagent = screen.getByRole("button", { name: "Inspect tests — Running" });
    fireEvent.focus(subagent);
    expect(screen.getByRole("heading", { name: "Inspect tests" })).toBeTruthy();
    act(() => bridge.emit({ type: "tool-end", id: "todo-1", name: "todo", failed: false, todos: [{ id: "a", content: "Implement", status: "completed" }, { id: "b", content: "Verify", status: "in_progress" }] }));
    expect(screen.getByText("1 of 2 complete")).toBeTruthy();
    expect(screen.getByText("In progress")).toBeTruthy();
    act(() => bridge.emit({ type: "subagent-end", index: 0, goal: "Inspect tests", result: "Found coverage" }));
    expect(screen.getByRole("button", { name: "Inspect tests — Completed" })).toBeTruthy();
    expect(screen.getByText("Final result")).toBeTruthy();
    expect(screen.getByText("Found coverage")).toBeTruthy();

    act(() => bridge.emit({ type: "advisor-note", severity: "concern", text: "Keep the detail surface keyboard accessible." }));
    act(() => bridge.emit({ type: "advisor-note", severity: "blocker", text: "Avoid rendering advisor text in the transcript." }));
    expect(screen.queryByRole("heading", { name: "Advisor" })).toBeNull();
    const advisor = screen.getByRole("button", { name: "Advisor — 2 notes" });
    fireEvent.focus(advisor);
    expect(screen.getByRole("heading", { name: "Advisor notes" })).toBeTruthy();
    expect(screen.getByText("concern")).toBeTruthy();
    expect(screen.getByText("blocker")).toBeTruthy();
    expect(screen.getByText("Keep the detail surface keyboard accessible.")).toBeTruthy();
    expect([...document.querySelectorAll(".activity-dashboard-section")].map(section =>
      section.getAttribute("aria-label") ?? section.querySelector("h3")?.textContent,
    )).toEqual(["Advisor", "Todos", "Subagents"]);

    act(() => bridge.emit({ type: "subagent-start", index: 1, count: 2, goal: "Verify interruption" }));
    act(() => bridge.emit({ type: "run-end" }));
    expect(screen.getByRole("button", { name: "Verify interruption — Interrupted" })).toBeTruthy();
    act(() => bridge.emit({ type: "run-start" }));
    expect(screen.queryByRole("button", { name: /Inspect tests|Verify interruption|Advisor/u })).toBeNull();
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
