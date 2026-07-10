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

export const USAGE = "Usage: railgun [--print|-p <question>] [--resume|-r [session-id]] [--list-sessions] | railgun login | railgun logout | railgun config";

export type CliMode =
  | { kind: "fresh" }
  | { kind: "print"; question: string }
  | { kind: "resume"; id?: string }
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
  runRepl: (session: DevinSession, options?: ReplPersistenceOptions) => Promise<void>;
  runOneShot: (question: string) => Promise<void>;
  selectSession: (sessions: readonly SessionSummary[]) => Promise<string | undefined>;
  randomId: () => string;
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const parseCliArgs = (args: readonly string[]): CliMode => {
  if (args.length === 0) return { kind: "fresh" };
  const [flag, ...rest] = args;
  if (flag === "login" && rest.length === 0) return { kind: "login" };
  if (flag === "logout" && rest.length === 0) return { kind: "logout" };
  if (flag === "config" && rest.length === 0) return { kind: "config" };
  if (flag === "--print" || flag === "-p") return { kind: "print", question: rest.join(" ") || "Hello!" };
  if (flag === "--list-sessions" && rest.length === 0) return { kind: "list" };
  if ((flag === "--resume" || flag === "-r") && rest.length <= 1) {
    return rest[0] === undefined ? { kind: "resume" } : { kind: "resume", id: rest[0] };
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
  selectSession: runSessionChooser,
  randomId: randomUUID,
  now: () => new Date(),
  stdout: console.log,
  stderr: console.error,
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
  onFirstSave?: () => void,
): Promise<void> => {
  const session = await dependencies.initSession(persisted.model);
  await dependencies.runRepl(session, persistenceOptions(persisted, store, onFirstSave));
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
    await dependencies.runOneShot(mode.question);
    return;
  }

  if (mode.kind === "fresh") {
    const session = await dependencies.initFreshSession();
    if (session === undefined) return;
    await withStore(dependencies, async store => {
      const persisted: PersistedSession = {
        id: dependencies.randomId(),
        model: session.model.id,
        startedAt: dependencies.now().toISOString(),
        messages: [],
        todos: [],
      };
      await dependencies.runRepl(session, persistenceOptions(
        persisted,
        store,
        () => dependencies.stderr(`Session saved: ${persisted.id}`),
      ));
    });
    return;
  }

  await withStore(dependencies, async store => {
    if (mode.kind === "list") {
      const sessions = store.listSessions();
      dependencies.stdout(sessions.length === 0 ? "No saved sessions." : formatSessionTable(sessions));
      return;
    }

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
    await runPersistedRepl(persisted, store, dependencies);
  });
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
