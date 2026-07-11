import { describe, expect, it, vi } from "vitest";
import type { DevinSession } from "./session.js";
import type { AppConfig } from "./config.js";
import type { PersistedSession, SessionStore, SessionSummary } from "./persistence/sessionStore.js";
import { dispatchCli, parseCliArgs, type CliDependencies } from "./cli.js";
import type { ProjectTrustStore, TrustChoice, TrustDecision } from "./trust.js";
import type { DevinProvider, DevinModel } from "widevin";


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

const fakeSession: DevinSession = {
  devin: {} as DevinProvider,
  model: { id: "model-a" } as DevinModel,
  systemPrompt: ["test system prompt"] as const,
};

const fakeTrustStore = (): ProjectTrustStore => ({
  get: vi.fn((): TrustDecision => ({ status: "trusted", scope: "persisted" })),
  set: vi.fn((): TrustDecision => ({ status: "trusted", scope: "persisted" })),
});

const dependencies = (store = fakeStore()): CliDependencies => ({
  createStore: vi.fn(() => store),
  createNewTrustStore: vi.fn(fakeTrustStore),
  loadConfig: vi.fn(async (): Promise<AppConfig> => ({ model: null, defaultProjectTrust: "ask" })),
  initFreshSession: vi.fn(async () => fakeSession),
  initSession: vi.fn(async () => fakeSession),
  runLogin: vi.fn(async () => {}),
  runLogout: vi.fn(async () => {}),
  runRepl: vi.fn(async () => {}),
  runOneShot: vi.fn(async () => {}),
  promptTrustChoice: vi.fn(async (): Promise<TrustChoice> => "trust"),
  selectSession: vi.fn(async () => undefined),
  randomId: vi.fn(() => "fresh-id"),
  now: vi.fn(() => new Date("2026-07-10T00:00:00.000Z")),
  stdout: vi.fn(),
  stderr: vi.fn(),
  runCronScheduler: vi.fn(async () => {}),
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
    [["config"], { kind: "config" }],
    [["--approve"], { kind: "fresh", approve: true }],
    [["-a"], { kind: "fresh", approve: true }],
    [["--no-approve"], { kind: "fresh", noApprove: true }],
    [["-na"], { kind: "fresh", noApprove: true }],
    [["--approve", "--print", "hello"], { kind: "print", question: "hello", approve: true }],
    [["--resume", "abc", "--no-approve"], { kind: "resume", id: "abc", noApprove: true }],
  ] as const)("parses %j", (args, expected) => {
    expect(parseCliArgs([...args])).toEqual(expected);
  });

  it.each([
    ["extra"],
    ["login", "extra"],
    ["logout", "extra"],
    ["config", "extra"],
    ["--resume", "a", "b"],
    ["-r", "a", "b"],
    ["--list-sessions", "extra"],
    ["--unknown"],
    ["login", "--approve"],
    ["--approve", "--no-approve"],
    ["--list-sessions", "-a"],
  ])("rejects invalid arguments %j", (...args) => {
    expect(() => parseCliArgs(args)).toThrow(/Usage: railgun/);
  });
});


describe("dispatchCli", () => {
  it("prints effective pretty configuration without authentication, SQLite, file writes, or TUI startup", async () => {
    const deps = dependencies();
    vi.mocked(deps.loadConfig).mockResolvedValue({ model: null, future: { kept: true }, defaultProjectTrust: "ask" });

    await dispatchCli({ kind: "config" }, deps);

    expect(deps.stdout).toHaveBeenCalledWith('{\n  "model": null,\n  "future": {\n    "kept": true\n  },\n  "defaultProjectTrust": "ask"\n}');
    expect(deps.loadConfig).toHaveBeenCalledOnce();
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.initFreshSession).not.toHaveBeenCalled();
    expect(deps.initSession).not.toHaveBeenCalled();
    expect(deps.runLogin).not.toHaveBeenCalled();
    expect(deps.runRepl).not.toHaveBeenCalled();
  });

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
    expect(deps.runOneShot).toHaveBeenCalledWith("hello", expect.anything());
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.initSession).not.toHaveBeenCalled();
  });

  it("uses fresh-session configuration recovery and exits successfully when it is cancelled", async () => {
    const deps = dependencies();
    vi.mocked(deps.initFreshSession).mockResolvedValue(undefined);
    await dispatchCli({ kind: "fresh" }, deps);
    expect(deps.initFreshSession).toHaveBeenCalledOnce();
    expect(deps.runRepl).not.toHaveBeenCalled();
    expect(deps.createStore).not.toHaveBeenCalled();
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
    }), expect.anything(), expect.anything(), expect.anything());
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

describe("parseCliArgs — cron mode", () => {
  it("parses cron with no extra arguments", () => {
    expect(parseCliArgs(["cron"])).toEqual({ kind: "cron" });
  });

  it("rejects cron with extra arguments", () => {
    expect(() => parseCliArgs(["cron", "extra"])).toThrow(/Usage: railgun/);
  });

  it("rejects cron with --approve flag", () => {
    expect(() => parseCliArgs(["cron", "--approve"])).toThrow(/Usage: railgun/);
  });

  it("rejects cron with --no-approve flag", () => {
    expect(() => parseCliArgs(["cron", "--no-approve"])).toThrow(/Usage: railgun/);
  });
});

describe("dispatchCli — cron mode", () => {
  it("calls initFreshSession and runCronScheduler", async () => {
    const deps = dependencies();
    await dispatchCli({ kind: "cron" }, deps);
    expect(deps.initFreshSession).toHaveBeenCalledOnce();
    expect(deps.runCronScheduler).toHaveBeenCalledOnce();
  });

  it("exits cleanly without calling runCronScheduler when initFreshSession returns undefined", async () => {
    const deps = dependencies();
    vi.mocked(deps.initFreshSession).mockResolvedValue(undefined);
    await dispatchCli({ kind: "cron" }, deps);
    expect(deps.runCronScheduler).not.toHaveBeenCalled();
  });

  it("does not call createStore, runRepl, or runOneShot for cron mode", async () => {
    const deps = dependencies();
    await dispatchCli({ kind: "cron" }, deps);
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.runRepl).not.toHaveBeenCalled();
    expect(deps.runOneShot).not.toHaveBeenCalled();
  });

  it("passes the AbortSignal, session devin/model/systemPrompt, and loaded config to runCronScheduler", async () => {
    const deps = dependencies();
    const config = { model: "m", defaultProjectTrust: "ask" as const, approvalMode: "off" as const };
    vi.mocked(deps.loadConfig).mockResolvedValue(config);
    await dispatchCli({ kind: "cron" }, deps);
    expect(deps.loadConfig).toHaveBeenCalledOnce();
    const [calledDevin, calledModel, calledPrompt, calledConfig, calledSignal] =
      vi.mocked(deps.runCronScheduler).mock.calls[0] ?? [];
    expect(calledDevin).toBe(fakeSession.devin);
    expect(calledModel).toBe(fakeSession.model);
    expect(calledPrompt).toBe(fakeSession.systemPrompt);
    expect(calledConfig).toEqual(config);
    expect(calledSignal).toBeInstanceOf(AbortSignal);
  });
});
