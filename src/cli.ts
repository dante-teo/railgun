import type { ExtensionRunner } from "./extensions/runner.js";
import { createExtensionRunner } from "./extensions/runner.js";
import { loadExtensions, registerExtensionTools } from "./extensions/loader.js";
import { homedir } from "node:os";
import { registry } from "./tools/index.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import { describeDevinError } from "./errors.js";
import { runLoginCommand, runLogoutCommand } from "./auth.js";
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

export const USAGE = "Usage: railgun [--print|-p <question>] [--resume|-r [session-id]] [--list-sessions] [--approve|-a] [--no-approve|-na] | railgun login | railgun logout | railgun config";

export type CliMode =
  | { kind: "fresh"; approve?: boolean; noApprove?: boolean }
  | { kind: "print"; question: string; approve?: boolean; noApprove?: boolean }
  | { kind: "resume"; id?: string; approve?: boolean; noApprove?: boolean }
  | { kind: "list" }
  | { kind: "login" }
  | { kind: "logout" }
  | { kind: "config" };

export class CliUsageError extends Error {
  constructor() {
    super(USAGE);
    this.name = "CliUsageError";
  }
}

export interface CliDependencies {
  createStore: () => SessionStore;
  loadConfig: () => Promise<AppConfig>;
  initFreshSession: () => Promise<DevinSession | undefined>;
  initSession: (requiredModelId?: string) => Promise<DevinSession>;
  runLogin: () => Promise<void>;
  runLogout: () => Promise<void>;
  runRepl: (session: DevinSession, options?: ReplPersistenceOptions, extensionRunner?: ExtensionRunner, trustDecision?: TrustDecision, trustStore?: ProjectTrustStore) => Promise<void>;
  runOneShot: (question: string, extensionRunner?: ExtensionRunner) => Promise<void>;
  createNewTrustStore: () => ProjectTrustStore;
  promptTrustChoice: (cwd: string) => Promise<TrustChoice>;
  selectSession: (sessions: readonly SessionSummary[]) => Promise<string | undefined>;
  randomId: () => string;
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const parseCliArgs = (args: readonly string[]): CliMode => {
  let approve = false;
  let noApprove = false;

  const filteredArgs: string[] = [];
  for (const arg of args) {
    if (arg === "--approve" || arg === "-a") { approve = true; }
    else if (arg === "--no-approve" || arg === "-na") { noApprove = true; }
    else { filteredArgs.push(arg); }
  }

  if (approve && noApprove) throw new CliUsageError();

  const trustFlags = { ...(approve && { approve: true as const }), ...(noApprove && { noApprove: true as const }) };

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
  if (flag === "--print" || flag === "-p") return { kind: "print", question: rest.join(" ") || "Hello!", ...trustFlags };
  if (flag === "--list-sessions" && rest.length === 0) {
    if (approve || noApprove) throw new CliUsageError();
    return { kind: "list" };
  }
  if ((flag === "--resume" || flag === "-r") && rest.length <= 1) {
    return rest[0] === undefined ? { kind: "resume", ...trustFlags } : { kind: "resume", id: rest[0], ...trustFlags };
  }
  throw new CliUsageError();
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
  initFreshSession: initFreshDevinSession,
  initSession: initDevinSession,
  runLogin: runLoginCommand,
  runLogout: runLogoutCommand,
  runRepl,
  runOneShot,
  createNewTrustStore: createProjectTrustStore,
  promptTrustChoice: promptTrustChoiceReadline,
  selectSession: runSessionChooser,
  randomId: randomUUID,
  now: () => new Date(),
  stdout: console.log,
  stderr: console.error,
};

const resolveSessionTrust = async (
  mode: { approve?: boolean; noApprove?: boolean },
  dependencies: CliDependencies,
): Promise<{ decision: TrustDecision; store: ProjectTrustStore }> => {
  const config = await dependencies.loadConfig();
  const store = dependencies.createNewTrustStore();
  const decision = await resolveProjectTrust(process.cwd(), store, {
    ...(mode.approve && { cliApprove: true as const }),
    ...(mode.noApprove && { cliNoApprove: true as const }),
    defaultTrust: config.defaultProjectTrust,
    promptTrustChoice: dependencies.promptTrustChoice,
  });
  return { decision, store };
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
  };
};

const runPersistedRepl = async (
  persisted: PersistedSession,
  store: SessionStore,
  dependencies: CliDependencies,
  extensionRunner?: ExtensionRunner,
  trustDecision?: TrustDecision,
  trustStore?: ProjectTrustStore,
  onFirstSave?: () => void,
): Promise<void> => {
  const session = await dependencies.initSession(persisted.model);
  await dependencies.runRepl(session, persistenceOptions(persisted, store, onFirstSave), extensionRunner, trustDecision, trustStore);
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

// Creates, wires, and loads extensions for one session. The returned runner is already
// primed; caller is responsible for emitting session_start/session_shutdown around the run.
const bootstrapExtensions = async (sessionId: string): Promise<ExtensionRunner> => {
  const runner = createExtensionRunner();
  runner.onExtensionError(err => console.error("[extension error]", err.extension, err.event, err.error));
  // TODO: gate on project trust
  await loadExtensions(runner, { cwd: process.cwd(), homeDir: homedir(), trusted: true });
  registerExtensionTools(runner, registry, sessionId);
  return runner;
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
    const { decision } = await resolveSessionTrust(mode, dependencies);
    const runner = await bootstrapExtensions("oneshot");
    await runner.emitSessionStart({ type: "session_start", reason: "new" });
    await dependencies.runOneShot(mode.question, runner);
    await runner.emitSessionShutdown({ type: "session_shutdown", reason: "exit" });
    return;
  }

  if (mode.kind === "fresh") {
    const { decision, store: trustStore } = await resolveSessionTrust(mode, dependencies);
    const session = await dependencies.initFreshSession();
    if (session === undefined) return;
    const sessionId = dependencies.randomId();
    const runner = await bootstrapExtensions(sessionId);
    await runner.emitSessionStart({ type: "session_start", reason: "new" });
    await withStore(dependencies, async store => {
      const persisted: PersistedSession = {
        id: sessionId,
        model: session.model.id,
        startedAt: dependencies.now().toISOString(),
        messages: [],
        todos: [],
      };
      await dependencies.runRepl(session, persistenceOptions(
        persisted,
        store,
        () => dependencies.stderr(`Session saved: ${persisted.id}`),
      ), runner, decision, trustStore);
    });
    await runner.emitSessionShutdown({ type: "session_shutdown", reason: "exit" });
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
    const { decision, store: trustStore } = await resolveSessionTrust(mode, dependencies);
    await withStore(dependencies, async store => {
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
      const runner = await bootstrapExtensions(persisted.id);
      await runner.emitSessionStart({ type: "session_start", reason: "resume" });
      await runPersistedRepl(persisted, store, dependencies, runner, decision, trustStore);
      await runner.emitSessionShutdown({ type: "session_shutdown", reason: "exit" });
    });
    return;
  }
};

export const main = async (args = process.argv.slice(2)): Promise<void> => {
  await dispatchCli(parseCliArgs(args));
};

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  // Piping stdout into a command that closes early (e.g. `| head`) makes
  // subsequent writes fail with EPIPE. Treat that as a successful consumer exit.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });

  main().catch((error: unknown) => {
    const message = describeDevinError(error) ?? (error instanceof Error ? error.message : String(error));
    console.error(message);
    process.exitCode = 1;
  });
}
