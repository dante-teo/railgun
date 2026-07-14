import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { DevinMessage } from "widevin";
import type { DevinSession } from "../session.js";
import { buildSessionCore } from "../session.js";
import type { AppConfig } from "../config.js";
import { isAdvisorActive, parseMoAPreset } from "../config.js";
import type { AgentDependencies } from "../agent/agent.js";
import type { ExtensionRunner } from "../extensions/runner.js";
import type { AgentSession } from "../agent/agentSession.js";
import { createAgentSession } from "../agent/agentSession.js";
import type { MemoryStore } from "../persistence/memoryStore.js";
import type { EmbedFn, NoteStore } from "../persistence/noteStore.js";
import type { SessionStore } from "../persistence/sessionStore.js";
import { createTodoStore } from "../tools/todo.js";
import { runCompaction } from "../agent/compaction.js";
import { serializeJsonLine, makeLineReader } from "./jsonl.js";
import { createRpcInteractions } from "./interactions.js";
import { parseRpcCommand } from "./protocol.js";
import { createRpcStoreHandler } from "./storeHandlers.js";
import type { RpcStoreDependencies } from "./storeHandlers.js";
import { createRpcSessionHandler } from "./sessionHandlers.js";
import { RPC_PROTOCOL_CAPABILITIES, RPC_PROTOCOL_VERSION } from "./types.js";
import type { RpcCommand } from "./types.js";
import { runDreamSession } from "../dream/dreamJob.js";
import type { InstructionFileService } from "../instructions/instructionFiles.js";

export interface RpcModeOptions {
  readonly session: DevinSession;
  readonly config: AppConfig;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly extensionRunner?: ExtensionRunner;
  readonly sessionStore?: SessionStore;
  readonly memoryStore?: MemoryStore;
  readonly noteStore?: NoteStore;
  readonly updateConfig?: RpcStoreDependencies["updateConfig"];
  readonly loadJobs?: RpcStoreDependencies["loadJobs"];
  readonly saveJobs?: RpcStoreDependencies["saveJobs"];
  readonly loadSkills?: RpcStoreDependencies["loadSkills"];
  readonly embedText?: EmbedFn;
  readonly randomId?: () => string;
  readonly now?: () => Date;
  readonly interactionTimeoutMs?: number;
  readonly resolveModelRuntime?: (modelId: string) => Promise<DevinSession>;
  readonly instructionFiles?: InstructionFileService;
  readonly runDream?: typeof runDreamSession;
}

const MANAGEMENT_COMMANDS = new Set<string>([
  "config_get", "config_update", "mcp_list", "mcp_upsert", "mcp_remove",
  "cron_list", "cron_add", "cron_update", "cron_remove",
  "memory_list", "memory_search", "memory_create", "memory_update", "memory_delete",
  "notes_import", "notes_search", "skills_list", "skill_get",
  "instruction_files_list", "instruction_file_get", "instruction_file_update",
]);

const SESSION_COMMANDS = new Set<string>([
  "session_new", "session_list", "session_load", "session_save", "session_branch", "session_fork", "session_recent_messages", "session_transcript",
]);
const MUTATING_MANAGEMENT_COMMANDS = new Set<string>([
  "config_update", "mcp_upsert", "mcp_remove", "cron_add", "cron_update", "cron_remove",
  "memory_create", "memory_update", "memory_delete", "notes_import", "instruction_file_update",
]);

const V1_ONLY_COMMANDS = new Set<string>([
  "approval_response", "clarification_response", "dream_run", ...SESSION_COMMANDS, ...MANAGEMENT_COMMANDS,
]);

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const configuredAgentActivity = (
  config: AppConfig,
): Pick<AgentDependencies, "moaPreset" | "advisor"> => {
  const presetName = config.activeMoaPreset;
  const rawPreset = presetName === undefined ? undefined : config.moaPresets?.[presetName];
  const advisorModel = isAdvisorActive(config) ? config.advisor?.model : undefined;
  return {
    ...(presetName === undefined || rawPreset === undefined ? {} : { moaPreset: parseMoAPreset(presetName, rawPreset) }),
    ...(advisorModel === undefined ? {} : { advisor: { model: advisorModel } }),
  };
};

export const runRpcMode = async (options: RpcModeOptions): Promise<void> => {
  const { session, stdin, stdout, extensionRunner } = options;
  const writeObject = (value: unknown): void => { stdout.write(serializeJsonLine(value)); };
  let config = options.config;
  let initialized = false;
  let hasRun = false;
  const newId = options.randomId ?? randomUUID;
  const now = options.now ?? (() => new Date());

  let legacyModel = session.model.id;
  let legacyHistory: readonly DevinMessage[] = [];
  const legacyTodos = createTodoStore();
  const approvals = new Set<string>();
  const modelRuntimes = new Map<string, DevinSession>([[session.model.id, session]]);
  const pendingModelRuntimes = new Map<string, Promise<DevinSession>>();
  const contextDirtyModels = new Set<string>();

  const prepareModelRuntime = async (modelId: string): Promise<void> => {
    if (modelRuntimes.has(modelId) && !contextDirtyModels.has(modelId)) return;
    let pending = pendingModelRuntimes.get(modelId);
    if (pending === undefined) {
      pending = (options.resolveModelRuntime ?? (async (requiredModelId: string) => {
        const models = await session.devin.listModels();
        const model = models.find(candidate => candidate.id === requiredModelId);
        if (model === undefined) {
          const available = models.map(candidate => candidate.id).join(", ") || "none";
          throw new Error(`Model "${requiredModelId}" is unavailable. Available models: ${available}.`);
        }
        return buildSessionCore(session.devin, model);
      }))(modelId);
      pendingModelRuntimes.set(modelId, pending);
    }
    try {
      const runtime = await pending;
      if (runtime.model.id !== modelId) {
        throw new Error(`Resolved model runtime mismatch: expected ${modelId}, received ${runtime.model.id}`);
      }
      modelRuntimes.set(modelId, runtime);
      contextDirtyModels.delete(modelId);
    } finally {
      pendingModelRuntimes.delete(modelId);
    }
  };

  const requireModelRuntime = (modelId: string): DevinSession => {
    const runtime = modelRuntimes.get(modelId);
    if (runtime === undefined) throw new Error(`Model runtime is not prepared: ${modelId}`);
    return runtime;
  };

  type RunSlot = { session: AgentSession; promise: Promise<void>; cmdId: string | undefined };
  const run: { current: RunSlot | null } = { current: null };
  const pendingOperations = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pendingOperations.add(operation);
    void operation.then(() => pendingOperations.delete(operation), () => pendingOperations.delete(operation));
    return operation;
  };
  const sessionHandler = createRpcSessionHandler({
    ...(options.sessionStore === undefined ? {} : { store: options.sessionStore }),
    devin: session.devin,
    defaultModel: session.model.id,
    isRunning: () => run.current !== null,
    prepareModel: prepareModelRuntime,
    randomId: newId,
    now,
  });

  const respond = (command: string, id: string | undefined, data?: unknown, error?: string): void => {
    const base = { ...(id === undefined ? {} : { id }), type: "response" as const, command };
    writeObject(error === undefined
      ? { ...base, success: true, ...(data === undefined ? {} : { data }) }
      : { ...base, success: false, error });
  };

  const interactions = createRpcInteractions(writeObject, {
    randomId: newId,
    ...(options.interactionTimeoutMs === undefined ? {} : { timeoutMs: options.interactionTimeoutMs }),
  });

  const storeHandler = createRpcStoreHandler({
    getConfig: () => config,
    setConfig: value => { config = value; },
    ...(options.memoryStore === undefined ? {} : { memoryStore: options.memoryStore }),
    ...(options.noteStore === undefined ? {} : { noteStore: options.noteStore }),
    ...(options.updateConfig === undefined ? {} : { updateConfig: options.updateConfig }),
    ...(options.loadJobs === undefined ? {} : { loadJobs: options.loadJobs }),
    ...(options.saveJobs === undefined ? {} : { saveJobs: options.saveJobs }),
    ...(options.loadSkills === undefined ? {} : { loadSkills: options.loadSkills }),
    ...(options.embedText === undefined ? {} : { embedText: options.embedText }),
    ...(options.instructionFiles === undefined ? {} : { instructionFiles: options.instructionFiles }),
    onInstructionsUpdated: () => { for (const modelId of modelRuntimes.keys()) contextDirtyModels.add(modelId); },
    randomId: newId,
  });

  const checkpointAfterRun = (): void => {
    if (!initialized || sessionHandler.active.history.length === 0) return;
    try {
      sessionHandler.checkpoint();
    } catch (error) {
      writeObject({ type: "checkpoint_error", sessionId: sessionHandler.active.id, error: errorMessage(error) });
    }
  };

  const makeAgentSession = (): AgentSession => {
    const selected = initialized ? sessionHandler.active : undefined;
    const v1 = selected !== undefined;
    const model = selected?.model ?? legacyModel;
    const todos = selected?.todoStore ?? legacyTodos;
    const modelRuntime = selected === undefined ? session : requireModelRuntime(model);
    const agentSession = createAgentSession({
      devin: session.devin,
      model,
      contextWindow: modelRuntime.model.contextWindow,
      systemPrompt: modelRuntime.systemPrompt,
      confirmShellCommand: v1 ? interactions.requestApproval : async () => true,
      clarifyCallback: v1
        ? interactions.requestClarification
        : async question => { throw new Error(`clarify not supported in RPC mode — question: ${question}`); },
      todoStore: todos,
      commandApprovalMode: config.approvalMode ?? "manual",
      ...(config.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: config.operationTimeoutMs }),
      sessionApprovals: approvals,
      ...(config.reviewerModel === undefined ? {} : { reviewerModel: config.reviewerModel }),
      ...configuredAgentActivity(config),
      ...(extensionRunner === undefined ? {} : { extensionRunner }),
      ...(options.memoryStore === undefined ? {} : { memoryStore: options.memoryStore }),
      ...(options.noteStore === undefined ? {} : { noteStore: options.noteStore }),
    });
    agentSession.subscribe(writeObject);
    return agentSession;
  };

  const dispatch = (command: RpcCommand): void => {
    const id = command.id;

    if (command.type === "initialize") {
      if (initialized) { respond(command.type, id, undefined, "RPC connection is already initialized"); return; }
      if (hasRun || run.current !== null) { respond(command.type, id, undefined, "initialize must be called before the first run"); return; }
      if (command.version !== RPC_PROTOCOL_VERSION) {
        respond(command.type, id, undefined, `unsupported protocol version ${command.version}; supported version is ${RPC_PROTOCOL_VERSION}`);
        return;
      }
      initialized = true;
      sessionHandler.initialize();
      respond(command.type, id, { version: RPC_PROTOCOL_VERSION, capabilities: RPC_PROTOCOL_CAPABILITIES });
      return;
    }

    if (V1_ONLY_COMMANDS.has(command.type) && !initialized) {
      respond(command.type, id, undefined, "command requires protocol initialization");
      return;
    }

    if (command.type === "approval_response") {
      try { interactions.resolveApproval(command.requestId, command.approved); respond(command.type, id); }
      catch (error) { respond(command.type, id, undefined, errorMessage(error)); }
      return;
    }
    if (command.type === "clarification_response") {
      try { interactions.resolveClarification(command.requestId, command.answer); respond(command.type, id); }
      catch (error) { respond(command.type, id, undefined, errorMessage(error)); }
      return;
    }

    if (command.type === "prompt") {
      if (run.current !== null) { respond(command.type, id, undefined, "agent is already running"); return; }
      if (initialized && sessionHandler.busy) { respond(command.type, id, undefined, "session operation is in progress"); return; }
      hasRun = true;
      const agentSession = makeAgentSession();
      const history = initialized ? sessionHandler.active.history : legacyHistory;
      const promise = agentSession.run({ text: command.message, history })
        .then(outcome => {
          if (outcome.ok || "aborted" in outcome) {
            if (initialized) sessionHandler.active.history = outcome.messages; else legacyHistory = outcome.messages;
            checkpointAfterRun();
            respond("prompt", id);
          } else {
            respond("prompt", id, undefined, String(outcome.error));
          }
        })
        .catch(error => { respond("prompt", id, undefined, errorMessage(error)); })
        .finally(() => {
          interactions.rejectAll("agent run settled");
          run.current = null;
        });
      run.current = { session: agentSession, promise, cmdId: id };
      return;
    }

    if (command.type === "steer" || command.type === "follow_up") {
      try {
        if (run.current === null) throw new Error("Agent is not running");
        if (command.type === "steer") run.current.session.steer(command.message); else run.current.session.followUp(command.message);
        respond(command.type, id);
      } catch (error) { respond(command.type, id, undefined, errorMessage(error)); }
      return;
    }
    if (command.type === "abort") {
      interactions.rejectAll("agent run aborted");
      run.current?.session.abort();
      respond(command.type, id);
      return;
    }
    if (command.type === "get_state") {
      const selected = initialized ? sessionHandler.active : undefined;
      respond(command.type, id, {
        running: run.current !== null,
        model: selected?.model ?? legacyModel,
        messageCount: selected?.history.length ?? legacyHistory.length,
        todos: selected?.todoStore.read() ?? legacyTodos.read(),
        ...(selected === undefined ? {} : {
          protocolVersion: RPC_PROTOCOL_VERSION,
          sessionId: selected.id,
          startedAt: selected.startedAt,
          persistence: selected.persistence,
          ...(selected.checkpointError === undefined ? {} : { checkpointError: selected.checkpointError }),
        }),
      });
      return;
    }
    if (command.type === "get_messages") { respond(command.type, id, { messages: initialized ? sessionHandler.active.history : legacyHistory }); return; }
    if (command.type === "set_model") {
      if (!initialized) {
        legacyModel = command.modelId;
        respond(command.type, id);
        return;
      }
      void track(sessionHandler.setModel(command.modelId)
        .then(() => { approvals.clear(); respond(command.type, id); })
        .catch(error => respond(command.type, id, undefined, errorMessage(error))));
      return;
    }
    if (command.type === "get_available_models") {
      void track(session.devin.listModels().then(models => respond(command.type, id, { models })).catch(error => respond(command.type, id, undefined, errorMessage(error))));
      return;
    }
    if (command.type === "compact") {
      if (run.current !== null) { respond(command.type, id, undefined, "cannot compact while agent is running"); return; }
      if (initialized) {
        void track(sessionHandler.runExclusive("compact", async selected => {
          const runtime = requireModelRuntime(selected.model);
          const result = await runCompaction(session.devin, selected.model, runtime.systemPrompt, selected.history);
          selected.history = result.messages;
          checkpointAfterRun();
        }).then(() => respond(command.type, id)).catch(error => respond(command.type, id, undefined, errorMessage(error))));
      } else {
        void track(runCompaction(session.devin, legacyModel, session.systemPrompt, legacyHistory)
          .then(result => { legacyHistory = result.messages; respond(command.type, id); })
          .catch(error => respond(command.type, id, undefined, errorMessage(error))));
      }
      return;
    }
    if (command.type === "set_auto_compaction") { respond(command.type, id); return; }

    if (command.type === "dream_run") {
      if (run.current !== null) { respond(command.type, id, undefined, "cannot run Dream while agent is running"); return; }
      if (sessionHandler.busy) { respond(command.type, id, undefined, "cannot run Dream while another task operation is active"); return; }
      if (options.memoryStore === undefined) { respond(command.type, id, undefined, "memory store is unavailable"); return; }
      void track(sessionHandler.runExclusive("run Dream", async selected => {
        const runtime = requireModelRuntime(selected.model);
        return (options.runDream ?? runDreamSession)(
          options.memoryStore!, session.devin, runtime.model, () => undefined,
          progress => writeObject({ type: "dream_progress", ...progress }),
        );
      }).then(data => respond(command.type, id, data)).catch(error => respond(command.type, id, undefined, errorMessage(error))));
      return;
    }

    if (SESSION_COMMANDS.has(command.type)) {
      void track(sessionHandler.handle(command as Parameters<typeof sessionHandler.handle>[0])
        .then(data => {
          if (command.type === "session_new" || command.type === "session_load" || command.type === "session_fork") approvals.clear();
          respond(command.type, id, data);
        })
        .catch(error => respond(command.type, id, undefined, errorMessage(error))));
      return;
    }

    if (MANAGEMENT_COMMANDS.has(command.type)) {
      const handleStore = () => storeHandler(command as Parameters<typeof storeHandler>[0]);
      const operation = MUTATING_MANAGEMENT_COMMANDS.has(command.type)
        ? sessionHandler.runExclusive(`run ${command.type}`, handleStore)
        : handleStore();
      void track(operation
        .then(data => respond(command.type, id, data))
        .catch(error => respond(command.type, id, undefined, errorMessage(error))));
      return;
    }
  };

  const handleLine = (line: string): void => {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { respond("unknown", undefined, undefined, "parse_error: invalid JSON"); return; }
    try { dispatch(parseRpcCommand(value)); }
    catch (error) {
      const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
      respond(typeof record.type === "string" ? record.type : "unknown", typeof record.id === "string" ? record.id : undefined, undefined, errorMessage(error));
    }
  };

  const cleanupLineReader = makeLineReader(stdin, handleLine);
  const { promise: stdinDone, resolve: resolveStdinDone } = Promise.withResolvers<void>();
  stdin.once("end", resolveStdinDone);
  stdin.once("close", resolveStdinDone);
  await stdinDone;
  cleanupLineReader();
  interactions.rejectAll("RPC input closed");
  const current = run.current;
  if (current !== null) {
    current.session.abort();
    await current.promise;
  }
  await Promise.allSettled([...pendingOperations]);
};
