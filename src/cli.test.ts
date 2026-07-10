import { describe, expect, it, vi } from "vitest";
import type { DevinSession } from "./session.js";
import type { PersistedSession, SessionStore, SessionSummary } from "./persistence/sessionStore.js";
import { dispatchCli, parseCliArgs, type CliDependencies } from "./cli.js";

const summary = (id: string): SessionSummary => ({
  id,
  model: "model-a",
  startedAtLocal: "7/10/2026, 9:00:00 AM",
  messageCount: 2,
  firstUserPreview: "Remember me",
});

const fakeStore = (sessions: readonly SessionSummary[] = []): SessionStore => ({
  listSessions: vi.fn(() => sessions),
  loadSession: vi.fn((id: string): PersistedSession | undefined => id === "saved" ? {
    id,
    model: "model-a",
    startedAt: "2026-07-10T00:00:00.000Z",
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "hello" }] }],
    todos: [],
  } : undefined),
  saveCheckpoint: vi.fn(checkpoint => checkpoint),
  close: vi.fn(),
});

const fakeSession = { model: { id: "model-a" } } as DevinSession;

const dependencies = (store = fakeStore()): CliDependencies => ({
  createStore: vi.fn(() => store),
  initSession: vi.fn(async () => fakeSession),
  runLogin: vi.fn(async () => {}),
  runLogout: vi.fn(async () => {}),
  runRepl: vi.fn(async () => {}),
  runOneShot: vi.fn(async () => {}),
  selectSession: vi.fn(async () => undefined),
  randomId: vi.fn(() => "fresh-id"),
  now: vi.fn(() => new Date("2026-07-10T00:00:00.000Z")),
  stdout: vi.fn(),
  stderr: vi.fn(),
});

describe("parseCliArgs", () => {
  it.each([
    [[], { kind: "fresh" }],
    [["--resume", "abc"], { kind: "resume", id: "abc" }],
    [["--resume"], { kind: "resume" }],
    [["-r", "abc"], { kind: "resume", id: "abc" }],
    [["-r"], { kind: "resume" }],
    [["--list-sessions"], { kind: "list" }],
    [["--print", "hello", "world"], { kind: "print", question: "hello world" }],
    [["-p"], { kind: "print", question: "Hello!" }],
    [["login"], { kind: "login" }],
    [["logout"], { kind: "logout" }],
  ] as const)("parses %j", (args, expected) => {
    expect(parseCliArgs([...args])).toEqual(expected);
  });

  it.each([["extra"], ["login", "extra"], ["logout", "extra"], ["--resume", "a", "b"], ["-r", "a", "b"], ["--list-sessions", "extra"], ["--unknown"]])
    ("rejects invalid arguments %j", (...args) => {
      expect(() => parseCliArgs(args)).toThrow(/Usage: railgun/);
    });
});

describe("dispatchCli", () => {
  it.each([
    [{ kind: "login" as const }, "runLogin" as const],
    [{ kind: "logout" as const }, "runLogout" as const],
  ])("runs $command without opening SQLite, initializing Devin sessions, or starting the TUI", async (mode, command) => {
    const deps = dependencies();
    await dispatchCli(mode, deps);
    expect(deps[command]).toHaveBeenCalledOnce();
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.initSession).not.toHaveBeenCalled();
    expect(deps.runRepl).not.toHaveBeenCalled();
  });

  it("keeps print mode stateless and never opens the session database", async () => {
    const deps = dependencies();
    await dispatchCli({ kind: "print", question: "hello" }, deps);
    expect(deps.runOneShot).toHaveBeenCalledWith("hello");
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.initSession).not.toHaveBeenCalled();
  });

  it("lists sessions without initializing Devin", async () => {
    const deps = dependencies(fakeStore([summary("saved")]));
    await dispatchCli({ kind: "list" }, deps);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("saved"));
    expect(deps.initSession).not.toHaveBeenCalled();
    expect(deps.runRepl).not.toHaveBeenCalled();
  });

  it.each([{ kind: "list" as const }, { kind: "resume" as const }])
    ("prints the empty state and exits without Devin for $kind", async mode => {
      const deps = dependencies(fakeStore());
      await dispatchCli(mode, deps);
      expect(deps.stdout).toHaveBeenCalledWith("No saved sessions.");
      expect(deps.initSession).not.toHaveBeenCalled();
    });

  it("loads a direct resume with its required model and hydrated state", async () => {
    const store = fakeStore([summary("saved")]);
    const deps = dependencies(store);
    await dispatchCli({ kind: "resume", id: "saved" }, deps);

    expect(deps.initSession).toHaveBeenCalledWith("model-a");
    expect(deps.runRepl).toHaveBeenCalledWith(fakeSession, expect.objectContaining({
      initialHistory: expect.any(Array),
      initialTodos: [],
      sessionMetadata: expect.objectContaining({ id: "saved" }),
    }));
  });

  it("fails actionably for a missing direct session without initializing Devin", async () => {
    const deps = dependencies(fakeStore());
    await expect(dispatchCli({ kind: "resume", id: "missing" }, deps)).rejects.toThrow(/No saved session.*missing/);
    expect(deps.initSession).not.toHaveBeenCalled();
  });

  it("uses the keyboard chooser and does not initialize Devin when cancelled", async () => {
    const deps = dependencies(fakeStore([summary("saved")]));
    await dispatchCli({ kind: "resume" }, deps);
    expect(deps.selectSession).toHaveBeenCalledWith([summary("saved")]);
    expect(deps.initSession).not.toHaveBeenCalled();
    expect(deps.runRepl).not.toHaveBeenCalled();
  });

  it("resumes the session selected with the keyboard chooser", async () => {
    const deps = dependencies(fakeStore([summary("saved")]));
    vi.mocked(deps.selectSession).mockResolvedValue("saved");

    await dispatchCli({ kind: "resume" }, deps);

    expect(deps.selectSession).toHaveBeenCalledOnce();
    expect(deps.initSession).toHaveBeenCalledWith("model-a");
    expect(deps.runRepl).toHaveBeenCalledOnce();
  });
});
