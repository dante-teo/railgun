import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeDevinError } from "./errors.js";
import { runOneShot } from "./oneShot.js";
import { createSessionStore } from "./persistence/sessionStore.js";
import type { PersistedSession, SessionStore, SessionSummary } from "./persistence/sessionStore.js";
import { runRepl } from "./repl/App.js";
import type { ReplPersistenceOptions } from "./repl/App.js";
import { runSessionChooser } from "./repl/SessionChooser.js";
import { initDevinSession } from "./session.js";
import type { DevinSession } from "./session.js";

export const USAGE = "Usage: railgun [--print|-p <question>] [--resume [session-id]] [--list-sessions]";

export type CliMode =
  | { kind: "fresh" }
  | { kind: "print"; question: string }
  | { kind: "resume"; id?: string }
  | { kind: "list" };

export class CliUsageError extends Error {
  constructor() {
    super(USAGE);
    this.name = "CliUsageError";
  }
}

export interface CliDependencies {
  createStore: () => SessionStore;
  initSession: (requiredModelId?: string) => Promise<DevinSession>;
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
  if (flag === "--print" || flag === "-p") return { kind: "print", question: rest.join(" ") || "Hello!" };
  if (flag === "--list-sessions" && rest.length === 0) return { kind: "list" };
  if (flag === "--resume" && rest.length <= 1) {
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
  initSession: initDevinSession,
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

export const dispatchCli = async (mode: CliMode, dependencies: CliDependencies = defaultDependencies): Promise<void> => {
  if (mode.kind === "print") {
    await dependencies.runOneShot(mode.question);
    return;
  }

  const store = dependencies.createStore();
  try {
    if (mode.kind === "list") {
      const sessions = store.listSessions();
      dependencies.stdout(sessions.length === 0 ? "No saved sessions." : formatSessionTable(sessions));
      return;
    }

    if (mode.kind === "fresh") {
      const session = await dependencies.initSession();
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
  } finally {
    store.close();
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
