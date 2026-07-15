#!/usr/bin/env node

import type { ExtensionRunner } from "./extensions/runner.js";
import { createExtensionRunner } from "./extensions/runner.js";
import { loadExtensions, registerExtensionTools, createExtensionAPI } from "./extensions/loader.js";
import { homedir } from "node:os";
import { registry } from "./tools/index.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isCliEntryPoint } from "./cliEntryPoint.js";
import { loadConfig, updateConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import { createMcpExtension, parseMcpServers } from "./extensions/mcp/index.js";
import { describeDevinError } from "./errors.js";
import {
  AuthenticationRequiredError,
  CredentialRejectedError,
  DESKTOP_RPC_ENV,
  runLoginCommand,
  runLogoutCommand,
} from "./auth.js";
import { runOneShot } from "./oneShot.js";
import { createSessionStore } from "./persistence/sessionStore.js";
import type { PersistedSession, SessionStore, SessionSummary } from "./persistence/sessionStore.js";
import { runRepl } from "./repl/App.js";
import type { ReplPersistenceOptions } from "./repl/App.js";
import { runSessionChooser } from "./repl/SessionChooser.js";
import { initDevinSession, initFreshDevinSession } from "./session.js";
import type { DevinSession } from "./session.js";
import type { DevinProvider, DevinModel } from "widevin";
import { startScheduler } from "./cron/scheduler.js";
import { createMemoryStore, formatMemoriesForPrompt } from "./persistence/memoryStore.js";
import type { MemoryStore } from "./persistence/memoryStore.js";
import { createNoteStore } from "./persistence/noteStore.js";
import type { NoteStore } from "./persistence/noteStore.js";
import { embedText } from "./persistence/embedder.js";
import { runRpcMode } from "./rpc/rpcMode.js";
import type { RpcModeOptions } from "./rpc/rpcMode.js";
import { runAcpMode } from "./acp/acpMode.js";
import type { AcpModeOptions } from "./acp/acpMode.js";
import { runDreamSession } from "./dream/dreamJob.js";
import { loadJobs, saveJobs } from "./cron/jobs.js";
import { loadSkills } from "./skills.js";
import { installDaemon, uninstallDaemon, statusDaemon, formatStatus } from "./cron/daemon.js";
import type { DaemonStatus } from "./cron/daemon.js";
import { createInteractiveDiagnostics, createUnavailableInteractiveDiagnostics } from "./diagnostics/interactiveDiagnostics.js";
import type { InteractiveDiagnostics } from "./diagnostics/interactiveDiagnostics.js";
import type { OperationStart } from "./diagnostics/types.js";
import type { RuntimeSurface } from "./runtime.js";

export const USAGE = "Usage: railgun [--print|-p <question>] [--resume|-r [session-id]] [--list-sessions] | railgun login | railgun logout | railgun config | railgun cron [install|uninstall|status] | railgun import-notes <folder> | railgun --mode rpc | railgun --mode acp | railgun dream";

export type CliMode =
  | { kind: "fresh" }
  | { kind: "print"; question: string }
  | { kind: "resume"; id?: string }
  | { kind: "list" }
  | { kind: "login" }
  | { kind: "logout" }
  | { kind: "config" }
  | { kind: "cron" }
  | { kind: "cron-install" }
  | { kind: "cron-uninstall" }
  | { kind: "cron-status" }
  | { kind: "rpc" }
  | { kind: "acp" }
  | { kind: "import-notes"; folder: string }
  | { kind: "dream" };

export class CliUsageError extends Error {
  constructor() {
    super(USAGE);
    this.name = "CliUsageError";
  }
}

export interface CliDependencies {
  createStore: () => SessionStore;
  loadConfig: () => Promise<AppConfig>;
  initFreshSession: (memoriesText?: string | null, surface?: RuntimeSurface) => Promise<DevinSession | undefined>;
  initSession: (requiredModelId?: string, memoriesText?: string | null, surface?: RuntimeSurface) => Promise<DevinSession>;
  runLogin: () => Promise<void>;
  runLogout: () => Promise<void>;
  runRepl: (session: DevinSession, options?: ReplPersistenceOptions, extensionRunner?: ExtensionRunner, memoryStore?: MemoryStore, noteStore?: NoteStore, diagnostics?: InteractiveDiagnostics) => Promise<void>;
  runOneShot: (question: string, extensionRunner?: ExtensionRunner, memoryStore?: MemoryStore, noteStore?: NoteStore) => Promise<void>;
  runRpc: (options: RpcModeOptions) => Promise<void>;
  runAcp: (options: AcpModeOptions) => Promise<void>;
  selectSession: (sessions: readonly SessionSummary[]) => Promise<string | undefined>;
  randomId: () => string;
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  runCronScheduler: (devin: DevinProvider, model: DevinModel, systemPrompt: readonly string[], config: AppConfig, signal: AbortSignal) => Promise<void>;
  runCronInstall: () => void;
  runCronUninstall: () => void;
  runCronStatus: () => DaemonStatus;
  createInteractiveDiagnostics?: () => InteractiveDiagnostics;
}

export const parseCliArgs = (args: readonly string[]): { mode: CliMode } => {
  const parseMode = (): CliMode => {
    if (args.length === 0) return { kind: "fresh" };
    const [flag, ...rest] = args;
    if (flag === "login" && rest.length === 0) {
      return { kind: "login" };
    }
    if (flag === "logout" && rest.length === 0) {
      return { kind: "logout" };
    }
    if (flag === "config" && rest.length === 0) {
      return { kind: "config" };
    }
    if (flag === "cron") {
      if (rest.length === 0) return { kind: "cron" };
      if (rest.length === 1 && rest[0] === "install") return { kind: "cron-install" };
      if (rest.length === 1 && rest[0] === "uninstall") return { kind: "cron-uninstall" };
      if (rest.length === 1 && rest[0] === "status") return { kind: "cron-status" };
      throw new CliUsageError();
    }
    if (flag === "import-notes" && rest.length === 1) {
      return { kind: "import-notes", folder: rest[0]! };
    }
    if (flag === "dream" && rest.length === 0) {
      return { kind: "dream" };
    }
    if (flag === "--print" || flag === "-p") return { kind: "print", question: rest.join(" ") || "Hello!" };
    if (flag === "--list-sessions" && rest.length === 0) {
      return { kind: "list" };
    }
    if ((flag === "--resume" || flag === "-r") && rest.length <= 1) {
      return rest[0] === undefined ? { kind: "resume" } : { kind: "resume", id: rest[0] };
    }
    if (flag === "--mode") {
      if (rest.length !== 1) throw new CliUsageError();
      if (rest[0] === "rpc") {
        return { kind: "rpc" };
      }
      if (rest[0] === "acp") {
        return { kind: "acp" };
      }
      throw new CliUsageError();
    }
    throw new CliUsageError();
  };

  return { mode: parseMode() };
};

export const formatSessionTable = (sessions: readonly SessionSummary[]): string => {
  const rows = sessions.map((session, index) =>
    `${String(index + 1).padStart(2)}  ${session.startedAtLocal}  ${String(session.messageCount).padStart(4)} msgs  ${session.model}  ${session.id}  ${session.firstUserPreview || "(no user message)"}`
  );
  return [" #  Started  Messages  Model  Session ID  First message", ...rows].join("\n");
};

const defaultDependencies: CliDependencies = {
  createStore: createSessionStore,
  loadConfig,
  initFreshSession: (memoriesText, surface) => initFreshDevinSession({ ...(memoriesText !== undefined ? { memoriesText } : {}), ...(surface !== undefined ? { surface } : {}) }),
  initSession: (modelId, memoriesText, surface) => initDevinSession(modelId, memoriesText, surface),
  runLogin: runLoginCommand,
  runLogout: runLogoutCommand,
  runRepl,
  runOneShot,
  runRpc: runRpcMode,
  runAcp: runAcpMode,
  selectSession: runSessionChooser,
  randomId: randomUUID,
  now: () => new Date(),
  stdout: console.log,
  stderr: console.error,
  runCronScheduler: (devin, model, systemPrompt, config, signal) =>
    startScheduler(devin, model, systemPrompt, config, { signal }),
  runCronInstall: () => installDaemon(),
  runCronUninstall: () => uninstallDaemon(),
  runCronStatus: () => statusDaemon(),
  createInteractiveDiagnostics,
};

type PhaseOutcome = "success" | "failure" | "timeout" | "abort";

const observePhase = async <T>(
  diagnostics: InteractiveDiagnostics | undefined,
  input: OperationStart,
  run: () => Promise<T>,
  outcome: (value: T) => PhaseOutcome = () => "success",
): Promise<T> => {
  const operation = diagnostics?.observer.start(input);
  try {
    const value = await run();
    operation?.end(outcome(value));
    return value;
  } catch (error) {
    operation?.end("failure", error);
    throw error;
  }
};

const persistenceOptions = (
  persisted: PersistedSession,
  store: SessionStore,
  onFirstSave?: () => void,
): ReplPersistenceOptions => {
  let hasSaved = onFirstSave === undefined;
  return {
    initialHistory: persisted.messages,
    initialTodos: persisted.todos,
    sessionMetadata: { id: persisted.id, model: persisted.model, startedAt: persisted.startedAt },
    checkpoint: (messages, todos) => {
      store.saveCheckpoint({ ...persisted, messages, todos });
      if (!hasSaved) {
        hasSaved = true;
        onFirstSave?.();
      }
    },
    branch: (messageId) => store.branch(persisted.id, messageId),
    branchWithSummary: async (_messageId) => {
      // Patched in runPersistedRepl once the devin session is available.
      throw new Error("branchWithSummary requires a live devin session");
    },
    fork: () => {
      const newId = store.forkSession(persisted.id);
      const newSession = store.loadSession(newId);
      if (!newSession) throw new Error("Fork failed: new session not found");
      return { sessionId: newId, messages: newSession.messages };
    },
    getRecentMessages: () => store.getRecentMessages(persisted.id),
    loadBranch: () => {
      const reloaded = store.loadSession(persisted.id);
      return reloaded?.messages ?? [];
    },
  };
};

const runPersistedRepl = async (
  persisted: PersistedSession,
  store: SessionStore,
  dependencies: CliDependencies,
  memoryStore: MemoryStore,
  noteStore: NoteStore,
  extensionRunner?: ExtensionRunner,
  diagnostics?: InteractiveDiagnostics,
  onFirstSave?: () => void,
): Promise<void> => {
  const session = await observePhase(
    diagnostics,
    { phase: "session_initialization", sessionId: persisted.id },
    () => dependencies.initSession(persisted.model, formatMemoriesForPrompt(memoryStore.recent(20))),
  );
  const opts = persistenceOptions(persisted, store, onFirstSave);
  // Patch branchWithSummary now that we have a live devin provider.
  opts.branchWithSummary = async (messageId) => {
    await store.branchWithSummary(persisted.id, messageId, session.devin, session.model.id);
  };
  diagnostics?.observer.ready();
  if (diagnostics) await dependencies.runRepl(session, opts, extensionRunner, memoryStore, noteStore, diagnostics);
  else await dependencies.runRepl(session, opts, extensionRunner, memoryStore, noteStore);
};

const withStore = async <T>(
  dependencies: CliDependencies,
  run: (store: SessionStore) => Promise<T>,
): Promise<T> => {
  const store = dependencies.createStore();
  try {
    return await run(store);
  } finally {
    store.close();
  }
};

const withStores = async <T>(
  dependencies: CliDependencies,
  run: (store: SessionStore, memoryStore: MemoryStore, noteStore: NoteStore) => Promise<T>,
): Promise<T> => {
  const store = dependencies.createStore();
  const memoryStore = createMemoryStore(store.db);
  const noteStore = createNoteStore(store.db);
  try {
    return await run(store, memoryStore, noteStore);
  } finally {
    store.close();
  }
};

// Creates, wires, and loads extensions for one session. The returned runner is already
// primed; caller is responsible for emitting session_start/session_shutdown around the run.
// Returns a cleanup fn that kills MCP child processes on shutdown.
const bootstrapExtensions = async (
  sessionId: string,
  config: AppConfig,
  diagnostics?: InteractiveDiagnostics,
): Promise<{ runner: ExtensionRunner; cleanup: () => void }> => {
  const runner = createExtensionRunner();
  runner.onExtensionError(err => {
    console.error("[extension error]", err.extension, err.event, err.error);
    diagnostics?.observer.event({
      event: "extension_failure",
      severity: "error",
      phase: err.event,
      outcome: "failure",
      errorClass: err.error instanceof Error ? err.error.name : "ExtensionError",
    });
  });
  await loadExtensions(runner, { homeDir: homedir() });

  // MCP: load configured servers as extension tools
  const mcpServers = parseMcpServers(config.mcpServers);
  let mcpCleanup: (() => void) | undefined;
  if (Object.keys(mcpServers).length > 0) {
    const mcpFactory = createMcpExtension(mcpServers);
    const api = createExtensionAPI(runner, "mcp");
    const handle = await mcpFactory(api);
    mcpCleanup = handle.close;
  }

  registerExtensionTools(runner, registry, sessionId);
  return { runner, cleanup: mcpCleanup ?? (() => {}) };
};

const dispatchCliCore = async (mode: CliMode, dependencies: CliDependencies, diagnostics?: InteractiveDiagnostics): Promise<void> => {
  if (mode.kind === "login") {
    await dependencies.runLogin();
    return;
  }
  if (mode.kind === "logout") {
    await dependencies.runLogout();
    return;
  }
  if (mode.kind === "config") {
    dependencies.stdout(JSON.stringify(await dependencies.loadConfig(), null, 2));
    return;
  }
  if (mode.kind === "print") {
    const config = await dependencies.loadConfig();
    const { runner, cleanup } = await bootstrapExtensions("oneshot", config);
    try {
      await runner.emitSessionStart({ type: "session_start", reason: "new" });
      await withStores(dependencies, async (_store, memoryStore, noteStore) => {
        await dependencies.runOneShot(mode.question, runner, memoryStore, noteStore);
      });
      await runner.emitSessionShutdown({ type: "session_shutdown", reason: "exit" });
    } finally {
      cleanup();
    }
    return;
  }

  if (mode.kind === "fresh") {
    const config = await dependencies.loadConfig();
    const sessionId = dependencies.randomId();
    const { runner, cleanup } = await observePhase(
      diagnostics,
      { phase: "extensions_mcp", sessionId },
      () => bootstrapExtensions(sessionId, config, diagnostics),
    );
    try {
      await runner.emitSessionStart({ type: "session_start", reason: "new" });
      await withStores(dependencies, async (store, memoryStore, noteStore) => {
        const memoriesText = formatMemoriesForPrompt(memoryStore.recent(20));
        const session = await observePhase(
          diagnostics,
          { phase: "session_initialization", sessionId },
          () => dependencies.initFreshSession(memoriesText),
          value => value === undefined ? "abort" : "success",
        );
        if (session === undefined) return;
        const persisted: PersistedSession = {
          id: sessionId,
          model: session.model.id,
          startedAt: dependencies.now().toISOString(),
          messages: [],
          todos: [],
        };
        const opts = persistenceOptions(persisted, store, () => dependencies.stderr(`Session saved: ${persisted.id}`));
        opts.branchWithSummary = async (messageId) => {
          await store.branchWithSummary(persisted.id, messageId, session.devin, session.model.id);
        };
        diagnostics?.observer.ready();
        if (diagnostics) await dependencies.runRepl(session, opts, runner, memoryStore, noteStore, diagnostics);
        else await dependencies.runRepl(session, opts, runner, memoryStore, noteStore);
      });
      await runner.emitSessionShutdown({ type: "session_shutdown", reason: "exit" });
    } finally {
      cleanup();
    }
    return;
  }

  if (mode.kind === "list") {
    await withStore(dependencies, async store => {
      const sessions = store.listSessions();
      dependencies.stdout(sessions.length === 0 ? "No saved sessions." : formatSessionTable(sessions));
    });
    return;
  }
  if (mode.kind === "resume") {
    const config = await dependencies.loadConfig();
    await withStores(dependencies, async (store, memoryStore, noteStore) => {
      let id = mode.id;
      if (id === undefined) {
        const sessions = store.listSessions();
        if (sessions.length === 0) {
          dependencies.stdout("No saved sessions.");
          return;
        }
        id = await dependencies.selectSession(sessions);
        if (id === undefined) return;
      }
      const persisted = store.loadSession(id);
      if (!persisted) throw new Error(`No saved session found with ID "${id}". Run railgun --list-sessions to see available sessions.`);
      const { runner, cleanup } = await observePhase(
        diagnostics,
        { phase: "extensions_mcp", sessionId: persisted.id },
        () => bootstrapExtensions(persisted.id, config, diagnostics),
      );
      try {
        await runner.emitSessionStart({ type: "session_start", reason: "resume" });
        await runPersistedRepl(persisted, store, dependencies, memoryStore, noteStore, runner, diagnostics);
        await runner.emitSessionShutdown({ type: "session_shutdown", reason: "exit" });
      } finally {
        cleanup();
      }
    });
    return;
  }
  if (mode.kind === "import-notes") {
    await withStores(dependencies, async (_store, _memoryStore, noteStore) => {
      let importError: unknown;
      let imported = 0;
      let backfilled = 0;
      try {
        imported = await noteStore.importFolderWithEmbeddings(mode.folder, embedText);
        dependencies.stdout(`Imported ${imported} note chunks from ${mode.folder}.`);
      } catch (err) {
        importError = err;
      }
      try {
        backfilled = await noteStore.backfillEmbeddings(embedText);
      } catch (err) {
        if (importError === undefined) throw err;
        // import already failed — suppress secondary backfill error
      }
      if (backfilled > 0) {
        dependencies.stdout(`Backfilled embeddings for ${backfilled} previously imported notes.`);
      }
      if (importError !== undefined) throw importError;
    });
    return;
  }
  if (mode.kind === "dream") {
    const session = await dependencies.initSession();
    await withStores(dependencies, async (_store, memoryStore, noteStore) => {
      await runDreamSession(memoryStore, noteStore, session.devin, session.model);
    });
    return;
  }

  if (mode.kind === "cron") {
    const session = await dependencies.initFreshSession(undefined, "cron");
    if (session === undefined) return;
    const config = await dependencies.loadConfig();
    const controller = new AbortController();
    const onSignal = (): void => { controller.abort(); };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      await dependencies.runCronScheduler(session.devin, session.model, session.systemPrompt, config, controller.signal);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    return;
  }

  if (mode.kind === "cron-install") {
    dependencies.runCronInstall();
    return;
  }

  if (mode.kind === "cron-uninstall") {
    dependencies.runCronUninstall();
    return;
  }

  if (mode.kind === "cron-status") {
    dependencies.stdout(formatStatus(dependencies.runCronStatus()));
    return;
  }

  if (mode.kind === "rpc") {
    const surface: RuntimeSurface = process.env[DESKTOP_RPC_ENV] === "1" ? "desktop" : "rpc";
    const session = await dependencies.initSession(undefined, undefined, surface);
    const config = await dependencies.loadConfig();
    const { runner, cleanup } = await bootstrapExtensions("rpc", config);
    try {
      await withStores(dependencies, async (sessionStore, memoryStore, noteStore) => {
        await runner.emitSessionStart({ type: "session_start", reason: "new" });
        await dependencies.runRpc({
          session,
          config,
          stdin: process.stdin,
          stdout: process.stdout,
          extensionRunner: runner,
          sessionStore,
          memoryStore,
          noteStore,
          updateConfig: transform => updateConfig(transform),
          loadJobs: () => loadJobs(),
          saveJobs: jobs => saveJobs(jobs),
          loadSkills,
          embedText,
          randomId: dependencies.randomId,
          now: dependencies.now,
        });
        await runner.emitSessionShutdown({ type: "session_shutdown", reason: "exit" });
      });
    } finally {
      cleanup();
    }
    return;
  }

  if (mode.kind === "acp") {
    const session = await dependencies.initSession(undefined, undefined, "acp");
    const config = await dependencies.loadConfig();
    const { runner, cleanup } = await bootstrapExtensions("acp", config);
    try {
      await runner.emitSessionStart({ type: "session_start", reason: "new" });
      await dependencies.runAcp({ session, config, stdin: process.stdin, stdout: process.stdout, extensionRunner: runner });
      await runner.emitSessionShutdown({ type: "session_shutdown", reason: "exit" });
    } finally {
      cleanup();
    }
    return;
  }
};

const tryCreateInteractiveDiagnostics = (dependencies: CliDependencies): InteractiveDiagnostics | undefined => {
  if (!dependencies.createInteractiveDiagnostics) return undefined;
  try {
    return dependencies.createInteractiveDiagnostics();
  } catch {
    return createUnavailableInteractiveDiagnostics();
  }
};

export const dispatchCli = async (mode: CliMode, dependencies: CliDependencies = defaultDependencies): Promise<void> => {
  const interactive = mode.kind === "fresh" || mode.kind === "resume";
  const diagnostics = interactive ? tryCreateInteractiveDiagnostics(dependencies) : undefined;
  if (!diagnostics) return dispatchCliCore(mode, dependencies);
  try {
    await dispatchCliCore(mode, dependencies, diagnostics);
  } catch (error) {
    diagnostics.observer.event({
      event: "interactive_failure",
      severity: "error",
      outcome: "failure",
      errorClass: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await diagnostics.close();
  }
};

export const establishHomeWorkingDirectory = (home = homedir()): void => {
  process.chdir(home);
};

export const resolveCliModePaths = (mode: CliMode, invocationDirectory: string): CliMode =>
  mode.kind === "import-notes"
    ? { ...mode, folder: resolve(invocationDirectory, mode.folder) }
    : mode;

export const main = async (args = process.argv.slice(2)): Promise<void> => {
  const { mode } = parseCliArgs(args);
  const resolvedMode = resolveCliModePaths(mode, process.cwd());
  establishHomeWorkingDirectory();
  await dispatchCli(resolvedMode);
};

export const desktopAuthenticationRequiredFrame = (
  error: unknown,
  desktopRpc = process.env[DESKTOP_RPC_ENV] === "1",
): string | undefined => {
  if (!desktopRpc) return undefined;
  const credentialSource = error instanceof CredentialRejectedError
    ? error.source
    : error instanceof AuthenticationRequiredError ? "file" : undefined;
  return credentialSource === undefined ? undefined : JSON.stringify({
    type: "startup_status",
    status: "authentication_required",
    credential_source: credentialSource,
  });
};

const isEntryPoint = isCliEntryPoint(process.argv[1], fileURLToPath(import.meta.url));

if (isEntryPoint) {
  // Piping stdout into a command that closes early (e.g. `| head`) makes
  // subsequent writes fail with EPIPE. Treat that as a successful consumer exit.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });

  main().catch((error: unknown) => {
    const startupFrame = desktopAuthenticationRequiredFrame(error);
    if (startupFrame !== undefined) {
      console.log(startupFrame);
      process.exitCode = 1;
      return;
    }
    const message = describeDevinError(error) ?? (error instanceof Error ? error.message : String(error));
    console.error(message);
    process.exitCode = 1;
  });
}
