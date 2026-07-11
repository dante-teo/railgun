import type { Readable, Writable } from "node:stream";
import type { DevinMessage } from "widevin";
import type { DevinSession } from "../session.js";
import type { AppConfig } from "../config.js";
import type { ExtensionRunner } from "../extensions/runner.js";
import type { AgentSession } from "../agent/agentSession.js";
import { createAgentSession } from "../agent/agentSession.js";
import { createTodoStore } from "../tools/todo.js";
import { runCompaction } from "../agent/compaction.js";
import { serializeJsonLine, makeLineReader } from "./jsonl.js";
import type { RpcCommand } from "./types.js";

export interface RpcModeOptions {
  readonly session: DevinSession;
  readonly config: AppConfig;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly extensionRunner?: ExtensionRunner;
}

export const runRpcMode = async (options: RpcModeOptions): Promise<void> => {
  const { session, config, stdin, stdout, extensionRunner } = options;

  const write = (line: string): void => { stdout.write(line); };

  // Mutable state across prompts within the process
  let currentModel = session.model.id;
  let history: readonly DevinMessage[] = [];
  const todoStore = createTodoStore();
  const sessionApprovals = new Set<string>();

  // Current in-flight run slot
  type RunSlot = { session: AgentSession; promise: Promise<void>; cmdId: string | undefined };
  const run: { current: RunSlot | null } = { current: null };

  const respond = (cmdType: string, cmdId: string | undefined, data?: unknown, error?: string): void => {
    const base = { ...(cmdId !== undefined ? { id: cmdId } : {}), type: "response" as const, command: cmdType };
    write(serializeJsonLine(
      error === undefined
        ? { ...base, success: true, ...(data !== undefined ? { data } : {}) }
        : { ...base, success: false, error },
    ));
  };

  const errMsg = (err: unknown): string => err instanceof Error ? err.message : String(err);

  const makeSession = (): AgentSession => {
    const agentSession = createAgentSession({
      devin: session.devin,
      model: currentModel,
      contextWindow: session.model.contextWindow,
      systemPrompt: session.systemPrompt,
      confirmShellCommand: async () => true,
      clarifyCallback: async (question) => {
        throw new Error(`clarify not supported in RPC mode — question: ${question}`);
      },
      todoStore,
      commandApprovalMode: config.approvalMode ?? "manual",
      sessionApprovals,
      ...(config.reviewerModel !== undefined ? { reviewerModel: config.reviewerModel } : {}),
      ...(extensionRunner !== undefined ? { extensionRunner } : {}),
    });

    agentSession.subscribe(event => {
      write(serializeJsonLine(event));
    });

    return agentSession;
  };

  const dispatch = (cmd: RpcCommand): void => {
    const cmdId = cmd.id;

    if (cmd.type === "prompt") {
      if (run.current !== null) {
        respond(cmd.type, cmdId, undefined, "agent is already running");
        return;
      }

      const agentSession = makeSession();
      const runPromise: Promise<void> = agentSession
        .run({ text: cmd.message, history })
        .then(outcome => {
          if (outcome.ok) {
            history = outcome.messages;
          } else if ("aborted" in outcome) {
            // aborted — keep partial messages
            history = outcome.messages;
          } else {
            // error outcome
            respond("prompt", cmdId, undefined, String(outcome.error));
            return;
          }
          respond("prompt", cmdId);
        })
        .catch((err: unknown) => {
          respond("prompt", cmdId, undefined, errMsg(err));
        })
        .finally(() => {
          run.current = null;
        });

      run.current = { session: agentSession, promise: runPromise, cmdId };
      return;
    }

    if (cmd.type === "steer") {
      try {
        if (run.current === null) throw new Error("Agent is not running");
        run.current.session.steer(cmd.message);
        respond(cmd.type, cmdId);
      } catch (err) {
        respond(cmd.type, cmdId, undefined, errMsg(err));
      }
      return;
    }

    if (cmd.type === "follow_up") {
      try {
        if (run.current === null) throw new Error("Agent is not running");
        run.current.session.followUp(cmd.message);
        respond(cmd.type, cmdId);
      } catch (err) {
        respond(cmd.type, cmdId, undefined, errMsg(err));
      }
      return;
    }

    if (cmd.type === "abort") {
      if (run.current !== null) {
        run.current.session.abort();
      }
      respond(cmd.type, cmdId);
      return;
    }

    if (cmd.type === "get_state") {
      respond(cmd.type, cmdId, {
        running: run.current !== null,
        model: currentModel,
        messageCount: history.length,
        todos: todoStore.read(),
      });
      return;
    }

    if (cmd.type === "get_messages") {
      respond(cmd.type, cmdId, { messages: history });
      return;
    }

    if (cmd.type === "set_model") {
      currentModel = cmd.modelId;
      respond(cmd.type, cmdId);
      return;
    }

    if (cmd.type === "get_available_models") {
      session.devin.listModels()
        .then(models => { respond(cmd.type, cmdId, { models }); })
        .catch((err: unknown) => { respond(cmd.type, cmdId, undefined, errMsg(err)); });
      return;
    }

    if (cmd.type === "compact") {
      if (run.current !== null) {
        respond(cmd.type, cmdId, undefined, "cannot compact while agent is running");
        return;
      }
      runCompaction(session.devin, currentModel, session.systemPrompt, history)
        .then(result => {
          history = result.messages;
          respond(cmd.type, cmdId);
        })
        .catch((err: unknown) => { respond(cmd.type, cmdId, undefined, errMsg(err)); });
      return;
    }

    if (cmd.type === "set_auto_compaction") {
      // No agent-level API for this yet — acknowledge and no-op.
      respond(cmd.type, cmdId);
      return;
    }

    // All RpcCommand variants handled above — TypeScript exhaustive-check.
    const _: never = cmd;
    void _;
  };

  const handleLine = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      write(serializeJsonLine({ type: "response", command: "unknown", success: false, error: "parse_error: invalid JSON" }));
      return;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("type" in parsed) ||
      typeof (parsed as Record<string, unknown>).type !== "string"
    ) {
      write(serializeJsonLine({ type: "response", command: "unknown", success: false, error: "invalid command: missing type field" }));
      return;
    }

    dispatch(parsed as RpcCommand);
  };

  const cleanupLineReader = makeLineReader(stdin, handleLine);

  const { promise: stdinDone, resolve: resolveStdinDone } = Promise.withResolvers<void>();
  stdin.once("end", resolveStdinDone);
  stdin.once("close", resolveStdinDone);
  await stdinDone;

  cleanupLineReader();

  // If a run is still in progress, abort it and wait for it to finish
  const activeRun = run.current;
  if (activeRun !== null) {
    activeRun.session.abort();
    await activeRun.promise;
  }
};
