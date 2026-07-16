import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DevinSession } from "./session.js";
import type { AppConfig } from "./config.js";
import type { PersistedSession, SessionStore, SessionSummary } from "./persistence/sessionStore.js";
import { desktopAuthenticationRequiredFrame, dispatchCli, establishHomeWorkingDirectory, parseCliArgs, resolveCliModePaths, type CliDependencies } from "./cli.js";
import { DevinApiError, type DevinProvider, type DevinModel } from "widevin";
import { embedText } from "./persistence/embedder.js";
import { AuthenticationRequiredError, CredentialRejectedError } from "./auth.js";
import type { DaemonStatus } from "./cron/daemon.js";
import { createNoopInteractiveDiagnostics } from "./diagnostics/interactiveDiagnostics.js";

vi.mock("./persistence/embedder.js", () => ({
  embedText: vi.fn(async () => new Float32Array(384).fill(0.5)),
}));

describe("desktop authentication startup status", () => {
  it("emits the internal frame only for desktop authentication failures", () => {
    expect(desktopAuthenticationRequiredFrame(new AuthenticationRequiredError(), true)).toBe(
      '{"type":"startup_status","status":"authentication_required","credential_source":"file"}',
    );
    expect(desktopAuthenticationRequiredFrame(
      new CredentialRejectedError("environment", new DevinApiError("no", 401)),
      true,
    )).toBe('{"type":"startup_status","status":"authentication_required","credential_source":"environment"}');
    expect(desktopAuthenticationRequiredFrame(
      new CredentialRejectedError("file", new DevinApiError("no", 401)),
      true,
    )).toBe('{"type":"startup_status","status":"authentication_required","credential_source":"file"}');
    expect(desktopAuthenticationRequiredFrame(new AuthenticationRequiredError(), false)).toBeUndefined();
    expect(desktopAuthenticationRequiredFrame(new Error("network"), true)).toBeUndefined();
  });
});

describe("working directory", () => {
  it("always establishes the supplied home directory", async () => {
    const original = process.cwd();
    const home = await mkdtemp(join(tmpdir(), "railgun-home-"));
    try {
      establishHomeWorkingDirectory(home);
      expect(process.cwd()).toBe(await realpath(home));
    } finally {
      process.chdir(original);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("resolves relative note-import folders against the invocation directory", () => {
    const mode = { kind: "import-notes", folder: "./notes" } as const;

    expect(resolveCliModePaths(mode, "/work/project")).toEqual({
      kind: "import-notes",
      folder: resolve("/work/project", "notes"),
    });
  });

  it("preserves absolute note-import folders and unrelated modes", () => {
    const absolute = { kind: "import-notes", folder: "/shared/notes" } as const;
    const rpc = { kind: "rpc" } as const;

    expect(resolveCliModePaths(absolute, "/work/project")).toEqual(absolute);
    expect(resolveCliModePaths(rpc, "/work/project")).toBe(rpc);
  });
});


const summary = (id: string): SessionSummary => ({
  id,
  model: "model-a",
  startedAtLocal: "7/10/2026, 9:00:00 AM",
  messageCount: 2,
  firstUserPreview: "Remember me",
});

const makeMemoriesDb = (): Database.Database => {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL, created_at REAL NOT NULL)");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT, content TEXT NOT NULL, created_at REAL NOT NULL)");
  db.exec("CREATE VIRTUAL TABLE notes_fts USING fts5(content)");
  db.exec("CREATE VIRTUAL TABLE notes_vec USING vec0(embedding FLOAT[384])");
  return db;
};

const fakeStore = (sessions: readonly SessionSummary[] = []): SessionStore => ({
  listSessions: vi.fn(() => sessions),
  listArchivedSessions: vi.fn(() => []),
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
  pruneArchivedSessions: vi.fn(() => 0),
  loadSession: vi.fn((id: string): PersistedSession | undefined => id === "saved" ? {
    id,
    model: "model-a",
    startedAt: "2026-07-10T00:00:00.000Z",
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "hello" }] }],
    todos: [],
  } : undefined),
  saveCheckpoint: vi.fn(checkpoint => checkpoint),
  branch: vi.fn(),
  branchWithSummary: vi.fn(async () => {}),
  forkSession: vi.fn(() => "forked-id"),
  getActiveBranchMessageIds: vi.fn(() => []),
  getRecentMessages: vi.fn(() => []),
  close: vi.fn(),
  db: makeMemoriesDb(),
});

const fakeSession: DevinSession = {
  devin: {} as DevinProvider,
  model: { id: "model-a" } as DevinModel,
  systemPrompt: ["test system prompt"] as const,
};

const dependencies = (store = fakeStore()): CliDependencies => ({
  createStore: vi.fn(() => store),
  loadConfig: vi.fn(async (): Promise<AppConfig> => ({ model: null })),
  initFreshSession: vi.fn(async () => fakeSession),
  initSession: vi.fn(async () => fakeSession),
  runLogin: vi.fn(async () => {}),
  runLogout: vi.fn(async () => {}),
  runRepl: vi.fn(async () => {}),
  runOneShot: vi.fn(async () => {}),
  runRpc: vi.fn(async () => {}),
  runAcp: vi.fn(async () => {}),
  selectSession: vi.fn(async () => undefined),
  randomId: vi.fn(() => "fresh-id"),
  now: vi.fn(() => new Date("2026-07-10T00:00:00.000Z")),
  stdout: vi.fn(),
  stderr: vi.fn(),
  runCronScheduler: vi.fn(async () => {}),
  runCronInstall: vi.fn(() => {}),
  runCronUninstall: vi.fn(() => {}),
  runCronStatus: vi.fn((): DaemonStatus => ({ installed: false, running: false, platform: "darwin", serviceFile: "/tmp/fake.plist", logDir: "/tmp/.railgun/cron/logs", detail: "" })),
});

describe("parseCliArgs", () => {
  it.each([
    [[], { mode: { kind: "fresh" } }],
    [["--resume", "abc"], { mode: { kind: "resume", id: "abc" } }],
    [["--resume"], { mode: { kind: "resume" } }],
    [["-r", "abc"], { mode: { kind: "resume", id: "abc" } }],
    [["-r"], { mode: { kind: "resume" } }],
    [["--list-sessions"], { mode: { kind: "list" } }],
    [["--print", "hello", "world"], { mode: { kind: "print", question: "hello world" } }],
    [["-p"], { mode: { kind: "print", question: "Hello!" } }],
    [["login"], { mode: { kind: "login" } }],
    [["logout"], { mode: { kind: "logout" } }],
    [["config"], { mode: { kind: "config" } }],
    [["--mode", "rpc"], { mode: { kind: "rpc" } }],
    [["--mode", "acp"], { mode: { kind: "acp" } }],
    [["import-notes", "/some/path"], { mode: { kind: "import-notes", folder: "/some/path" } }],
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
    ["--approve"],
    ["-a"],
    ["--no-approve"],
    ["-na"],
    ["--cwd", "/tmp"],
    ["-C", "/tmp"],
    ["login", "--approve"],
    ["--approve", "--no-approve"],
    ["--list-sessions", "-a"],
    ["--mode", "rpc", "--approve"],
    ["--mode"],
    ["--mode", "unknown"],
    ["--cwd"],
  ])("rejects invalid arguments %j", (...args) => {
    expect(() => parseCliArgs(args)).toThrow(/Usage: railgun/);
  });

  it("rejects --mode acp with --approve", () => {
    expect(() => parseCliArgs(["--mode", "acp", "--approve"])).toThrow(/Usage: railgun/);
  });

  it("rejects import-notes with no folder argument", () => {
    expect(() => parseCliArgs(["import-notes"])).toThrow(/Usage: railgun/);
  });

  it("rejects import-notes with --approve flag", () => {
    expect(() => parseCliArgs(["--approve", "import-notes", "/path"])).toThrow(/Usage: railgun/);
  });
});

describe("parseCliArgs — dream mode", () => {
  it("parses dream with no extra arguments", () => {
    expect(parseCliArgs(["dream"])).toEqual({ mode: { kind: "dream" } });
  });

  it("rejects dream with extra arguments", () => {
    expect(() => parseCliArgs(["dream", "extra"])).toThrow(/Usage: railgun/);
  });

  it("rejects dream with --approve flag", () => {
    expect(() => parseCliArgs(["--approve", "dream"])).toThrow(/Usage: railgun/);
  });

  it("rejects dream with --no-approve flag", () => {
    expect(() => parseCliArgs(["--no-approve", "dream"])).toThrow(/Usage: railgun/);
  });
});


describe("dispatchCli", () => {
  it.each(["fresh", "resume"] as const)("starts and closes diagnostics for %s even when startup fails", async kind => {
    const deps = dependencies();
    const noopDiagnostics = createNoopInteractiveDiagnostics();
    const close = vi.fn(async () => {});
    const diagnostics = { ...noopDiagnostics, close };
    deps.createInteractiveDiagnostics = vi.fn(() => diagnostics);
    vi.mocked(deps.loadConfig).mockRejectedValue(new Error("startup failed"));

    await expect(dispatchCli(kind === "fresh" ? { kind } : { kind, id: "saved" }, deps)).rejects.toThrow("startup failed");

    expect(deps.createInteractiveDiagnostics).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("continues an interactive session with unavailable status when diagnostics construction throws", async () => {
    const deps = dependencies();
    deps.createInteractiveDiagnostics = vi.fn(() => { throw new Error("worker unavailable"); });

    await dispatchCli({ kind: "fresh" }, deps);

    expect(deps.runRepl).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.runRepl).mock.calls[0]?.[5]?.status.kind).toBe("unavailable");
  });

  it.each(["print", "rpc", "acp", "cron", "config", "login", "logout", "list"] as const)("does not create interactive logs in %s mode", async kind => {
    const deps = dependencies();
    deps.createInteractiveDiagnostics = vi.fn(createNoopInteractiveDiagnostics);
    if (kind === "print") await dispatchCli({ kind, question: "hi" }, deps);
    else await dispatchCli({ kind } as Parameters<typeof dispatchCli>[0], deps);
    expect(deps.createInteractiveDiagnostics).not.toHaveBeenCalled();
  });

  it("prints effective pretty configuration without authentication, SQLite, file writes, or TUI startup", async () => {
    const deps = dependencies();
    vi.mocked(deps.loadConfig).mockResolvedValue({ model: null, future: { kept: true } });

    await dispatchCli({ kind: "config" }, deps);

    expect(deps.stdout).toHaveBeenCalledWith('{\n  "model": null,\n  "future": {\n    "kept": true\n  }\n}');
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

  it("keeps print mode stateless: never starts a Devin session but does open the store for memories", async () => {
    const deps = dependencies();
    await dispatchCli({ kind: "print", question: "hello" }, deps);
    expect(deps.runOneShot).toHaveBeenCalledWith("hello", expect.anything(), expect.anything(), expect.anything());
    expect(deps.initSession).not.toHaveBeenCalled();
  });

  it("uses fresh-session configuration recovery and exits successfully when it is cancelled", async () => {
    const deps = dependencies();
    vi.mocked(deps.initFreshSession).mockResolvedValue(undefined);
    await dispatchCli({ kind: "fresh" }, deps);
    expect(deps.initFreshSession).toHaveBeenCalledOnce();
    expect(deps.runRepl).not.toHaveBeenCalled();
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

    expect(deps.initSession).toHaveBeenCalledWith("model-a", null);
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
    expect(deps.initSession).toHaveBeenCalledWith("model-a", null);
    expect(deps.runRepl).toHaveBeenCalledOnce();
  });

  it("dispatches rpc mode with persistent stores and closes them after shutdown", async () => {
    const store = fakeStore();
    const deps = dependencies(store);
    await dispatchCli({ kind: "rpc" }, deps);
    expect(deps.initSession).toHaveBeenCalledWith(undefined, undefined, "rpc");
    expect(deps.loadConfig).toHaveBeenCalledOnce();
    expect(deps.runRpc).toHaveBeenCalledWith(expect.objectContaining({
      session: fakeSession,
      config: expect.objectContaining({ model: null }),
      sessionStore: store,
      memoryStore: expect.anything(),
      noteStore: expect.anything(),
    }));
    expect(deps.createStore).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
    expect(deps.runRepl).not.toHaveBeenCalled();
  });

  it("dispatches acp mode: initializes session and calls runAcp without opening the store", async () => {
    const deps = dependencies();
    await dispatchCli({ kind: "acp" }, deps);
    expect(deps.initSession).toHaveBeenCalledWith(undefined, undefined, "acp");
    expect(deps.loadConfig).toHaveBeenCalledOnce();
    expect(deps.runAcp).toHaveBeenCalledWith(expect.objectContaining({
      session: fakeSession,
      config: expect.objectContaining({ model: null }),
    }));
    expect(deps.createStore).not.toHaveBeenCalled();
    expect(deps.runRepl).not.toHaveBeenCalled();
  });
});

describe("dispatchCli — dream mode", () => {
  it("opens the store and calls initSession for dream mode", async () => {
    const deps = dependencies();
    await dispatchCli({ kind: "dream" }, deps);
    expect(deps.initSession).toHaveBeenCalledOnce();
    expect(deps.createStore).toHaveBeenCalledOnce();
  });

  it("exits cleanly when there are fewer than 5 memories", async () => {
    const deps = dependencies();
    await dispatchCli({ kind: "dream" }, deps);
    expect(deps.initSession).toHaveBeenCalledOnce();
    expect(deps.runRepl).not.toHaveBeenCalled();
    expect(deps.runOneShot).not.toHaveBeenCalled();
  });
});

describe("parseCliArgs — cron mode", () => {
  it("parses cron with no extra arguments", () => {
    expect(parseCliArgs(["cron"])).toEqual({ mode: { kind: "cron" } });
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
    expect(deps.initFreshSession).toHaveBeenCalledWith(undefined, "cron");
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
    const config = { model: "m", approvalMode: "off" as const };
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

describe("parseCliArgs — cron daemon subcommands", () => {
  it.each([
    [["cron", "install"],   { kind: "cron-install" }],
    [["cron", "uninstall"], { kind: "cron-uninstall" }],
    [["cron", "status"],    { kind: "cron-status" }],
  ] as const)("parses %j", (args, expected) => {
    expect(parseCliArgs([...args])).toEqual({ mode: expected });
  });

  it("rejects cron install with --approve flag", () => {
    expect(() => parseCliArgs(["cron", "install", "--approve"])).toThrow(/Usage: railgun/);
  });

  it("rejects cron install with extra argument", () => {
    expect(() => parseCliArgs(["cron", "install", "extra"])).toThrow(/Usage: railgun/);
  });

  it("rejects cron with unknown subcommand", () => {
    expect(() => parseCliArgs(["cron", "bogus"])).toThrow(/Usage: railgun/);
  });
});

describe("dispatchCli — cron daemon subcommands", () => {
  it("install: calls runCronInstall, no Devin session or store opened", async () => {
    const deps = dependencies();
    await dispatchCli({ kind: "cron-install" }, deps);
    expect(deps.runCronInstall).toHaveBeenCalledOnce();
    expect(deps.initSession).not.toHaveBeenCalled();
    expect(deps.initFreshSession).not.toHaveBeenCalled();
    expect(deps.createStore).not.toHaveBeenCalled();
  });

  it("uninstall: calls runCronUninstall, no Devin session or store opened", async () => {
    const deps = dependencies();
    await dispatchCli({ kind: "cron-uninstall" }, deps);
    expect(deps.runCronUninstall).toHaveBeenCalledOnce();
    expect(deps.initSession).not.toHaveBeenCalled();
    expect(deps.initFreshSession).not.toHaveBeenCalled();
    expect(deps.createStore).not.toHaveBeenCalled();
  });

  it("status: calls runCronStatus, prints formatStatus output, no Devin session or store opened", async () => {
    const deps = dependencies();
    const fakeStatus: DaemonStatus = { installed: true, running: true, platform: "darwin", serviceFile: "/fake.plist", logDir: "/fake/.railgun/cron/logs", detail: "PID=42" };
    vi.mocked(deps.runCronStatus).mockReturnValue(fakeStatus);
    await dispatchCli({ kind: "cron-status" }, deps);
    expect(deps.runCronStatus).toHaveBeenCalledOnce();
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("macOS (launchd)"));
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("PID=42"));
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining("Logs"));
    expect(deps.initSession).not.toHaveBeenCalled();
    expect(deps.initFreshSession).not.toHaveBeenCalled();
    expect(deps.createStore).not.toHaveBeenCalled();
  });

  it("install: propagates errors from runCronInstall", async () => {
    const deps = dependencies();
    vi.mocked(deps.runCronInstall).mockImplementation(() => { throw new Error("launchctl failed"); });
    await expect(dispatchCli({ kind: "cron-install" }, deps)).rejects.toThrow("launchctl failed");
  });
});

describe("dispatchCli — import-notes", () => {
  let notesDir: string;

  beforeEach(async () => {
    notesDir = await mkdtemp(join(tmpdir(), "railgun-cli-import-notes-"));
    vi.mocked(embedText).mockReset();
    vi.mocked(embedText).mockResolvedValue(new Float32Array(384).fill(0.5));
  });

  afterEach(async () => {
    await rm(notesDir, { recursive: true });
  });

  it("imports chunks, stores vectors, and prints the count", async () => {
    await writeFile(join(notesDir, "a.md"), "note alpha content");
    await writeFile(join(notesDir, "b.md"), "note beta content");
    const store = fakeStore();
    const deps = dependencies(store);
    await dispatchCli({ kind: "import-notes", folder: notesDir }, deps);
    expect(vi.mocked(deps.stdout).mock.calls.map(c => c[0])).toEqual(
      expect.arrayContaining([expect.stringContaining("Imported 2 note chunks")]),
    );
    // Both notes and both vectors are in the DB
    expect(store.db.prepare("SELECT count(*) FROM notes").pluck().get()).toBe(2);
    expect(store.db.prepare("SELECT count(*) FROM notes_vec").pluck().get()).toBe(2);
  });

  it("rethrows the import error but still backfills partial import, leaving notes_vec complete", async () => {
    await writeFile(join(notesDir, "a.md"), "first note");
    await writeFile(join(notesDir, "b.md"), "second note");
    const importError = new Error("embedder network failure");
    // call 1 (import chunk a): succeeds; call 2 (import chunk b): throws;
    // call 3 (backfill chunk b): succeeds
    vi.mocked(embedText)
      .mockResolvedValueOnce(new Float32Array(384).fill(0.1))
      .mockRejectedValueOnce(importError)
      .mockResolvedValueOnce(new Float32Array(384).fill(0.2));
    const store = fakeStore();
    const deps = dependencies(store);
    await expect(
      dispatchCli({ kind: "import-notes", folder: notesDir }, deps),
    ).rejects.toThrow("embedder network failure");
    // Backfill ran: both note rows exist and both have vectors
    expect(store.db.prepare("SELECT count(*) FROM notes").pluck().get()).toBe(2);
    expect(store.db.prepare("SELECT count(*) FROM notes_vec").pluck().get()).toBe(2);
    // Import failure means success line was NOT printed
    const lines = vi.mocked(deps.stdout).mock.calls.map(c => c[0]);
    expect(lines.some((l: string) => l.includes("Imported"))).toBe(false);
    // Backfill line printed
    expect(lines.some((l: string) => l.includes("Backfilled"))).toBe(true);
  });

  it("surfaces the import error, not a secondary backfill error, when both fail", async () => {
    await writeFile(join(notesDir, "a.md"), "first note");
    await writeFile(join(notesDir, "b.md"), "second note");
    const importError = new Error("import embedder failure");
    const backfillError = new Error("backfill embedder failure");
    // call 1 (import chunk a): succeeds; call 2 (import chunk b): throws importError;
    // call 3 (backfill chunk b): throws backfillError
    vi.mocked(embedText)
      .mockResolvedValueOnce(new Float32Array(384).fill(0.1))
      .mockRejectedValueOnce(importError)
      .mockRejectedValueOnce(backfillError);
    const store = fakeStore();
    const deps = dependencies(store);
    await expect(
      dispatchCli({ kind: "import-notes", folder: notesDir }, deps),
    ).rejects.toBe(importError);
  });

});
