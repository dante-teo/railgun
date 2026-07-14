#!/usr/bin/env node

import type { ExtensionRunner } from "./extensions/runner.js";
import { createExtensionRunner } from "./extensions/runner.js";
import { loadExtensions, registerExtensionTools, createExtensionAPI } from "./extensions/loader.js";
import { homedir } from "node:os";
import { registry } from "./tools/index.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { createProjectTrustStore, resolveProjectTrust, promptTrustChoiceReadline } from "./trust.js";
import type { TrustChoice, TrustDecision, ProjectTrustStore } from "./trust.js";
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

export const USAGE = "Usage: railgun [--cwd|-C <dir>] [--print|-p <question>] [--resume|-r [session-id]] [--list-sessions] [--approve|-a] [--no-approve|-na] | railgun login | railgun logout | railgun config | railgun cron | railgun import-notes <folder> | railgun --mode rpc | railgun --mode acp | railgun dream";

export type CliMode =
  | { kind: "fresh"; approve?: boolean; noApprove?: boolean }
  | { kind: "print"; question: string; approve?: boolean; noApprove?: boolean }
  | { kind: "resume"; id?: string; approve?: boolean; noApprove?: boolean }
  | { kind: "list" }
  | { kind: "login" }
  | { kind: "logout" }
  | { kind: "config" }
  | { kind: "cron" }
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
  initFreshSession: (memoriesText?: string | null) => Promise<DevinSession | undefined>;
  initSession: (requiredModelId?: string, memoriesText?: string | null) => Promise<DevinSession>;
  runLogin: () => Promise<void>;
  runLogout: () => Promise<void>;
  runRepl: (session: DevinSession, options?: ReplPersistenceOptions, extensionRunner?: ExtensionRunner, trustDecision?: TrustDecision, trustStore?: ProjectTrustStore, memoryStore?: MemoryStore, noteStore?: NoteStore) => Promise<void>;
  runOneShot: (question: string, extensionRunner?: ExtensionRunner, memoryStore?: MemoryStore, noteStore?: NoteStore) => Promise<void>;
  runRpc: (options: RpcModeOptions) => Promise<void>;
  runAcp: (options: AcpModeOptions) => Promise<void>;
  createNewTrustStore: () => ProjectTrustStore;
  promptTrustChoice: (cwd: string) => Promise<TrustChoice>;
  selectSession: (sessions: readonly SessionSummary[]) => Promise<string | undefined>;
  randomId: () => string;
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  runCronScheduler: (devin: DevinProvider, model: DevinModel, systemPrompt: readonly string[], config: AppConfig, signal: AbortSignal) => Promise<void>;
}

export const parseCliArgs = (args: readonly string[]): { mode: CliMode; cwd?: string } => {
  let approve = false;
  let noApprove = false;
  let cwdOverride: string | undefined;

  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--approve" || arg === "-a") { approve = true; }
    else if (arg === "--no-approve" || arg === "-na") { noApprove = true; }
    else if (arg === "--cwd" || arg === "-C") {
      const next = args[++i];
      if (next === undefined) throw new CliUsageError();
      cwdOverride = next;
    }
    else { filteredArgs.push(arg); }
  }

  if (approve && noApprove) throw new CliUsageError();

  const trustFlags = { ...(approve && { approve: true as const }), ...(noApprove && { noApprove: true as const }) };

  const cwdResult = cwdOverride !== undefined ? { cwd: cwdOverride } : {};

  const parseMode = (): CliMode => {
    if (filteredArgs.length === 0) return { kind: "fresh", ...trustFlags };
    const [flag, ...rest] = filteredArgs;
    if (flag === "login" && rest.length === 0) {
      if (approve || noApprove) throw new CliUsageError();
      return { kind: "login" };
    }
    if (flag === "logout" && rest.length === 0) {
      if (approve || noApprove) throw new CliUsageError();
      return { kind: "logout" };
    }
    if (flag === "config" && rest.length === 0) {
      if (approve || noApprove) throw new CliUsageError();
      return { kind: "config" };
    }
    if (flag === "cron" && rest.length === 0) {
      if (approve || noApprove) throw new CliUsageError();
      return { kind: "cron" };
    }
    if (flag === "import-notes" && rest.length === 1) {
      if (approve || noApprove) throw new CliUsageError();
      return { kind: "import-notes", folder: rest[0]! };
    }
    if (flag === "dream" && rest.length === 0) {
      if (approve || noApprove) throw new CliUsageError();
      return { kind: "dream" };
    }
    if (flag === "--print" || flag === "-p") return { kind: "print", question: rest.join(" ") || "Hello!", ...trustFlags };
    if (flag === "--list-sessions" && rest.length === 0) {
      if (approve || noApprove) throw new CliUsageError();
      return { kind: "list" };
    }
    if ((flag === "--resume" || flag === "-r") && rest.length <= 1) {
      return rest[0] === undefined ? { kind: "resume", ...trustFlags } : { kind: "resume", id: rest[0], ...trustFlags };
    }
    if (flag === "--mode") {
      if (rest.length !== 1) throw new CliUsageError();
      if (rest[0] === "rpc") {
        if (approve || noApprove) throw new CliUsageError();
        return { kind: "rpc" };
      }
      if (rest[0] === "acp") {
        if (approve || noApprove) throw new CliUsageError();
        return { kind: "acp" };
      }
      throw new CliUsageError();
    }
    throw new CliUsageError();
  };

  return { mode: parseMode(), ...cwdResult };
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
  initFreshSession: (memoriesText) => initFreshDevinSession({ ...(memoriesText !== undefined ? { memoriesText } : {}) }),
  initSession: (modelId, memoriesText) => initDevinSession(modelId, memoriesText),
  runLogin: runLoginCommand,
  runLogout: runLogoutCommand,
  runRepl,
  runOneShot,
  runRpc: runRpcMode,
  runAcp: runAcpMode,
  createNewTrustStore: createProjectTrustStore,
  promptTrustChoice: promptTrustChoiceReadline,
  selectSession: runSessionChooser,
  randomId: randomUUID,
  now: () => new Date(),
  stdout: console.log,
  stderr: console.error,
  runCronScheduler: (devin, model, systemPrompt, config, signal) =>
    startScheduler(devin, model, systemPrompt, config, { signal }),
};

const resolveSessionTrust = async (
  mode: { approve?: boolean; noApprove?: boolean },
  dependencies: CliDependencies,
): Promise<{ decision: TrustDecision; store: ProjectTrustStore; config: AppConfig }> => {
  const config = await dependencies.loadConfig();
  const store = dependencies.createNewTrustStore();
  const decision = await resolveProjectTrust(process.cwd(), store, {
    ...(mode.approve && { cliApprove: true as const }),
    ...(mode.noApprove && { cliNoApprove: true as const }),
    defaultTrust: config.defaultProjectTrust,
    promptTrustChoice: dependencies.promptTrustChoice,
  });
  return { decision, store, config };
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
  trustDecision?: TrustDecision,
  trustStore?: ProjectTrustStore,
  onFirstSave?: () => void,
): Promise<void> => {
  const session = await dependencies.initSession(persisted.model, formatMemoriesForPrompt(memoryStore.recent(20)));
  const opts = persistenceOptions(persisted, store, onFirstSave);
  // Patch branchWithSummary now that we have a live devin provider.
  opts.branchWithSummary = async (messageId) => {
    await store.branchWithSummary(persisted.id, messageId, session.devin, session.model.id);
  };
  await dependencies.runRepl(session, opts, extensionRunner, trustDecision, trustStore, memoryStore, noteStore);
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
): Promise<{ runner: ExtensionRunner; cleanup: () => void }> => {
  const runner = createExtensionRunner();
  runner.onExtensionError(err => console.error("[extension error]", err.extension, err.event, err.error));
  // TODO: gate on project trust
  await loadExtensions(runner, { cwd: process.cwd(), homeDir: homedir(), trusted: true });

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

export const dispatchCli = async (mode: CliMode, dependencies: CliDependencies = defaultDependencies): Promise<void> => {
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
    const { decision, config } = await resolveSessionTrust(mode, dependencies);
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
    const { decision, store: trustStore, config } = await resolveSessionTrust(mode, dependencies);
    const sessionId = dependencies.randomId();
    const { runner, cleanup } = await bootstrapExtensions(sessionId, config);
    try {
      await runner.emitSessionStart({ type: "session_start", reason: "new" });
      await withStores(dependencies, async (store, memoryStore, noteStore) => {
        const memoriesText = formatMemoriesForPrompt(memoryStore.recent(20));
        const session = await dependencies.initFreshSession(memoriesText);
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
        await dependencies.runRepl(session, opts, runner, decision, trustStore, memoryStore, noteStore);
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
    const { decision, store: trustStore, config } = await resolveSessionTrust(mode, dependencies);
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
      const { runner, cleanup } = await bootstrapExtensions(persisted.id, config);
      try {
        await runner.emitSessionStart({ type: "session_start", reason: "resume" });
        await runPersistedRepl(persisted, store, dependencies, memoryStore, noteStore, runner, decision, trustStore);
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
    await withStores(dependencies, async (_store, memoryStore) => {
      await runDreamSession(memoryStore, session.devin, session.model);
    });
    return;
  }

  if (mode.kind === "cron") {
    const session = await dependencies.initFreshSession();
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

  if (mode.kind === "rpc") {
    const session = await dependencies.initSession();
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
    const session = await dependencies.initSession();
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

const expandTilde = (p: string): string =>
  p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;

export const main = async (args = process.argv.slice(2)): Promise<void> => {
  const { mode, cwd } = parseCliArgs(args);
  if (cwd !== undefined) process.chdir(expandTilde(cwd));
  await dispatchCli(mode);
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
