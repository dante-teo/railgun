import type { DevinMessage } from "widevin";
import type { DevinSession } from "@railgun/core/session.js";
import type { AgentSession, AgentSessionEvent } from "@railgun/core/agent/agentSession.js";
import { createAgentSession } from "@railgun/core/agent/agentSession.js";
import { createTodoStore } from "@railgun/core/tools/todo.js";
import { runCompaction } from "@railgun/core/agent/compaction.js";
import type { AppConfig } from "@railgun/core/config.js";
import type { GatewayEvent, GatewaySessionState } from "./protocol.js";

export interface SessionManagerOptions {
  readonly devinSession: DevinSession;
  readonly config: AppConfig;
  readonly onEvent: (event: GatewayEvent) => void;
}

export interface SessionManager {
  readonly runPrompt: (cmdId: string, text: string) => void;
  readonly steer: (cmdId: string, text: string) => void;
  readonly followUp: (cmdId: string, text: string) => void;
  readonly abort: (cmdId: string) => void;
  readonly getState: (cmdId: string) => void;
  readonly getAvailableModels: (cmdId: string) => void;
  readonly setModel: (cmdId: string, modelId: string) => void;
  readonly compact: (cmdId: string) => void;
  readonly resolveApproval: (approved: boolean) => void;
  readonly resolveClarify: (answer: string) => void;
}

export const createSessionManager = (options: SessionManagerOptions): SessionManager => {
  const { devinSession, config, onEvent } = options;

  let currentModel = devinSession.model.id;
  let history: readonly DevinMessage[] = [];
  const todoStore = createTodoStore();
  const sessionApprovals = new Set<string>();

  // In-flight run slot — promise field omitted; callers never await it externally
  type RunSlot = { session: AgentSession; cmdId: string };
  let currentRun: RunSlot | null = null;

  // Pending async resolvers for interactive round-trips
  let approvalResolver: ((approved: boolean) => void) | null = null;
  let clarifyResolver: ((answer: string) => void) | null = null;

  const respond = (id: string, command: string, data?: unknown, error?: string): void => {
    const evt: GatewayEvent = error !== undefined
      ? { type: "response", id, command, success: false, error }
      : data !== undefined
        ? { type: "response", id, command, success: true, data }
        : { type: "response", id, command, success: true };
    onEvent(evt);
  };

  const errMsg = (err: unknown): string => err instanceof Error ? err.message : String(err);

  // Runs `fn` against the active session; responds with error if none is running.
  const withRunning = (cmdId: string, command: string, fn: (session: AgentSession) => void): void => {
    try {
      if (currentRun === null) throw new Error("Agent is not running");
      fn(currentRun.session);
      respond(cmdId, command);
    } catch (err) {
      respond(cmdId, command, undefined, errMsg(err));
    }
  };

  const getState = (): GatewaySessionState => ({
    running: currentRun !== null,
    model: currentModel,
    messageCount: history.length,
    todos: todoStore.read(),
  });

  const makeAgentSession = (): AgentSession => {
    const agentSession = createAgentSession({
      devin: devinSession.devin,
      model: currentModel,
      contextWindow: devinSession.model.contextWindow,
      systemPrompt: devinSession.systemPrompt,
      confirmShellCommand: async (command: string): Promise<boolean> => {
        onEvent({ type: "approval_request", command });
        const { promise, resolve } = Promise.withResolvers<boolean>();
        approvalResolver = resolve;
        return promise;
      },
      clarifyCallback: async (question: string, choices?: readonly string[]): Promise<string> => {
        onEvent({ type: "clarify_request", question, ...(choices ? { choices: [...choices] } : {}) });
        const { promise, resolve } = Promise.withResolvers<string>();
        clarifyResolver = resolve;
        return promise;
      },
      todoStore,
      commandApprovalMode: config.approvalMode ?? "manual",
      sessionApprovals,
    });

    agentSession.subscribe((event: AgentSessionEvent) => {
      if (event.type === "agent_settled") return;
      if (event.type === "queue_update") return;
      onEvent({ type: "event", event });
    });

    return agentSession;
  };

  return {
    runPrompt: (cmdId, text) => {
      if (currentRun !== null) {
        respond(cmdId, "prompt", undefined, "agent is already running");
        return;
      }

      const agentSession = makeAgentSession();
      agentSession
        .run({ text, history })
        .then(outcome => {
          if (outcome.ok) {
            history = outcome.messages;
          } else if ("aborted" in outcome) {
            history = outcome.messages;
          } else {
            respond(cmdId, "prompt", undefined, String(outcome.error));
            return;
          }
          respond(cmdId, "prompt");
        })
        .catch((err: unknown) => {
          respond(cmdId, "prompt", undefined, errMsg(err));
        })
        .finally(() => {
          currentRun = null;
          onEvent({ type: "state_update", state: getState() });
        });

      currentRun = { session: agentSession, cmdId };
    },

    steer: (cmdId, text) => {
      withRunning(cmdId, "steer", s => s.steer(text));
    },

    followUp: (cmdId, text) => {
      withRunning(cmdId, "follow_up", s => s.followUp(text));
    },

    abort: (cmdId) => {
      currentRun?.session.abort();
      respond(cmdId, "abort");
    },

    getState: (cmdId) => {
      respond(cmdId, "get_state", getState());
    },

    getAvailableModels: (cmdId) => {
      devinSession.devin.listModels()
        .then(models => { respond(cmdId, "get_available_models", { models }); })
        .catch((err: unknown) => { respond(cmdId, "get_available_models", undefined, errMsg(err)); });
    },

    setModel: (cmdId, modelId) => {
      currentModel = modelId;
      respond(cmdId, "set_model");
    },

    compact: (cmdId) => {
      if (currentRun !== null) {
        respond(cmdId, "compact", undefined, "cannot compact while agent is running");
        return;
      }
      runCompaction(devinSession.devin, currentModel, devinSession.systemPrompt, history)
        .then(result => {
          history = result.messages;
          respond(cmdId, "compact");
        })
        .catch((err: unknown) => { respond(cmdId, "compact", undefined, errMsg(err)); });
    },

    resolveApproval: (approved) => {
      approvalResolver?.(approved);
      approvalResolver = null;
    },

    resolveClarify: (answer) => {
      clarifyResolver?.(answer);
      clarifyResolver = null;
    },
  };
};
