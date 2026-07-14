import { randomUUID } from "node:crypto";
import type { DevinMessage, DevinProvider } from "widevin";
import type { SessionStore } from "../persistence/sessionStore.js";
import { createTodoStore } from "../tools/todo.js";
import type { TodoStore } from "../tools/todo.js";
import type { RpcCommand, RpcPersistenceStatus } from "./types.js";
import { createRpcTranscriptPage } from "./sessionTranscript.js";

type SessionCommand = Extract<RpcCommand, { type:
  "session_new" | "session_list" | "session_load" | "session_save" |
  "session_branch" | "session_fork" | "session_recent_messages" | "session_transcript" }>;

export interface RpcActiveSession {
  readonly id: string;
  readonly startedAt: string;
  model: string;
  history: readonly DevinMessage[];
  todoStore: TodoStore;
  persistence: RpcPersistenceStatus;
  checkpointError?: string;
}

export interface RpcSessionHandler {
  readonly active: RpcActiveSession;
  readonly busy: boolean;
  initialize(): RpcActiveSession;
  checkpoint(): void;
  setModel(modelId: string): Promise<void>;
  runExclusive<T>(operation: string, task: (active: RpcActiveSession) => Promise<T>): Promise<T>;
  handle(command: SessionCommand): Promise<unknown>;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const createRpcSessionHandler = (options: {
  readonly store?: SessionStore;
  readonly devin: DevinProvider;
  readonly defaultModel: string;
  readonly isRunning: () => boolean;
  readonly prepareModel?: (modelId: string) => Promise<void>;
  readonly randomId?: () => string;
  readonly now?: () => Date;
}): RpcSessionHandler => {
  const newId = options.randomId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  let active: RpcActiveSession | undefined;

  const fresh = (model = options.defaultModel): RpcActiveSession => ({
    id: newId(), startedAt: now().toISOString(), model, history: [], todoStore: createTodoStore(), persistence: "unsaved",
  });
  const requireActive = (): RpcActiveSession => {
    if (active === undefined) throw new Error("active session is unavailable");
    return active;
  };
  const requireStore = (): SessionStore => {
    if (options.store === undefined) throw new Error("session store is unavailable");
    return options.store;
  };
  const guardIdle = (operation: string): void => {
    if (options.isRunning()) throw new Error(`cannot ${operation} while agent is running`);
  };
  const activate = (persisted: NonNullable<ReturnType<SessionStore["loadSession"]>>): void => {
    active = {
      id: persisted.id,
      startedAt: persisted.startedAt,
      model: persisted.model,
      history: persisted.messages,
      todoStore: createTodoStore(persisted.todos),
      persistence: "saved",
    };
  };

  const checkpoint = (): void => {
    const selected = requireActive();
    if (selected.history.length === 0) throw new Error("cannot save an empty session");
    try {
      requireStore().saveCheckpoint({
        id: selected.id,
        model: selected.model,
        startedAt: selected.startedAt,
        messages: selected.history,
        todos: selected.todoStore.read(),
      });
      selected.persistence = "saved";
      delete selected.checkpointError;
    } catch (error) {
      selected.persistence = "error";
      selected.checkpointError = errorMessage(error);
      throw error;
    }
  };

  const execute = async (command: SessionCommand): Promise<unknown> => {
    switch (command.type) {
      case "session_new":
        guardIdle("create a new session");
        await options.prepareModel?.(command.modelId ?? options.defaultModel);
        active = fresh(command.modelId ?? options.defaultModel);
        return { sessionId: active.id };
      case "session_list": return { sessions: requireStore().listSessions() };
      case "session_load": {
        guardIdle("load a session");
        const persisted = requireStore().loadSession(command.sessionId);
        if (persisted === undefined) throw new Error(`session not found: ${command.sessionId}`);
        await options.prepareModel?.(persisted.model);
        activate(persisted);
        return {
          sessionId: persisted.id,
          ...(command.includeMessages === false ? {} : { messages: persisted.messages }),
        };
      }
      case "session_save":
        guardIdle("save a session");
        checkpoint();
        return { sessionId: requireActive().id };
      case "session_branch": {
        guardIdle("branch a session");
        const selected = requireActive();
        if (selected.persistence !== "saved") throw new Error("active session must be saved before branching");
        const store = requireStore();
        if (command.summarize) await store.branchWithSummary(selected.id, command.messageId, options.devin, selected.model);
        else store.branch(selected.id, command.messageId);
        const persisted = store.loadSession(selected.id);
        if (persisted === undefined) throw new Error(`session not found: ${selected.id}`);
        activate(persisted);
        return { messages: persisted.messages, recentMessages: store.getRecentMessages(persisted.id) };
      }
      case "session_fork": {
        guardIdle("fork a session");
        const store = requireStore();
        const sourceId = command.sessionId ?? requireActive().id;
        const source = store.loadSession(sourceId);
        if (source === undefined) throw new Error(`session not found: ${sourceId}`);
        await options.prepareModel?.(source.model);
        const forkId = store.forkSession(sourceId);
        const persisted = store.loadSession(forkId);
        if (persisted === undefined) throw new Error(`forked session not found: ${forkId}`);
        activate(persisted);
        return { sessionId: forkId, messages: persisted.messages };
      }
      case "session_recent_messages": {
        const selected = requireActive();
        const store = requireStore();
        const sessionId = command.sessionId ?? selected.id;
        if ((command.sessionId !== undefined || selected.persistence === "saved") && store.loadSession(sessionId) === undefined) {
          throw new Error(`session not found: ${sessionId}`);
        }
        return {
          messages: selected.persistence === "unsaved" && command.sessionId === undefined
            ? []
            : store.getRecentMessages(sessionId, command.limit),
        };
      }
      case "session_transcript": {
        const selected = requireActive();
        if (command.sessionId !== selected.id) throw new Error("requested transcript does not match the active session");
        return createRpcTranscriptPage(selected.id, selected.history, command.cursor, command.limit);
      }
    }
  };
  let queue = Promise.resolve();
  let pendingCount = 0;
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    pendingCount += 1;
    const operation = queue.then(task);
    queue = operation.then(() => undefined, () => undefined);
    void operation.then(() => { pendingCount -= 1; }, () => { pendingCount -= 1; });
    return operation;
  };
  const handle = (command: SessionCommand): Promise<unknown> => enqueue(() => execute(command));

  const setModel = (modelId: string): Promise<void> => enqueue(async () => {
    guardIdle("change model");
    const selected = requireActive();
    if (selected.model === modelId) return;
    await options.prepareModel?.(modelId);
    if (selected.persistence === "unsaved") {
      selected.model = modelId;
      return;
    }
    active = {
      id: newId(),
      startedAt: now().toISOString(),
      model: modelId,
      history: selected.history,
      todoStore: createTodoStore(selected.todoStore.read()),
      persistence: "unsaved",
    };
  });

  const runExclusive = <T>(operation: string, task: (selected: RpcActiveSession) => Promise<T>): Promise<T> =>
    enqueue(async () => {
      guardIdle(operation);
      return task(requireActive());
    });

  return {
    get active() { return requireActive(); },
    get busy() { return pendingCount > 0; },
    initialize: () => { active = fresh(); return active; },
    checkpoint,
    setModel,
    runExclusive,
    handle,
  };
};
