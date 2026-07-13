import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { agent, ndJsonStream, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { AgentApp, ContentBlock } from "@agentclientprotocol/sdk";
import type { DevinMessage } from "widevin";
import type { DevinSession } from "../session.js";
import type { AppConfig } from "../config.js";
import type { ExtensionRunner } from "../extensions/runner.js";
import type { AgentSession } from "../agent/agentSession.js";
import { createAgentSession } from "../agent/agentSession.js";
import { createTodoStore } from "../tools/todo.js";
import { mapToolKind } from "./toolKind.js";

export interface AcpModeOptions {
  readonly session: DevinSession;
  readonly config: AppConfig;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly extensionRunner?: ExtensionRunner;
}

export interface AcpAppOptions {
  readonly session: DevinSession;
  readonly config: AppConfig;
  readonly extensionRunner?: ExtensionRunner;
}

interface AcpSession {
  history: readonly DevinMessage[];
  activeRun: AgentSession | null;
}

/** Creates a configured ACP AgentApp. Exported for testing without real stdio. */
export const createAcpApp = (options: AcpAppOptions): AgentApp => {
  const { session, config, extensionRunner } = options;

  const sessions = new Map<string, AcpSession>();

  return agent({ name: "railgun" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: "railgun", title: "Railgun", version: "0.1.0" },
    }))
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.setMode, () => ({}))
    .onRequest(methods.agent.session.new, () => {
      const sessionId = randomUUID();
      sessions.set(sessionId, { history: [], activeRun: null });
      return { sessionId };
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const { sessionId, prompt } = ctx.params;
      const acpSession = sessions.get(sessionId);
      if (acpSession === undefined) {
        throw new Error(`Session ${sessionId} not found`);
      }
      if (acpSession.activeRun !== null) {
        throw new Error("A prompt is already running for this session");
      }

      const userText = extractText(prompt);

      const todoStore = createTodoStore();
      const sessionApprovals = new Set<string>();
      const agentSession = createAgentSession({
        devin: session.devin,
        model: session.model.id,
        contextWindow: session.model.contextWindow,
        systemPrompt: session.systemPrompt,
        confirmShellCommand: async () => true,
        clarifyCallback: async (question) => {
          throw new Error(`clarify not supported in ACP mode — question: ${question}`);
        },
        todoStore,
        commandApprovalMode: config.approvalMode ?? "manual",
        ...(config.operationTimeoutMs !== undefined ? { operationTimeoutMs: config.operationTimeoutMs } : {}),
        sessionApprovals,
        ...(config.reviewerModel !== undefined ? { reviewerModel: config.reviewerModel } : {}),
        ...(extensionRunner !== undefined ? { extensionRunner } : {}),
      });

      acpSession.activeRun = agentSession;

      let messageIdCounter = 0;
      agentSession.subscribe(async (event) => {
        if (event.type === "message_update" && event.streamEvent.type === "text_delta") {
          await ctx.client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: String(messageIdCounter),
              content: { type: "text", text: event.streamEvent.delta },
            },
          });
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          messageIdCounter++;
        } else if (event.type === "tool_execution_start") {
          await ctx.client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: event.toolCallId,
              title: buildToolLabel(event.toolName, event.args),
              kind: mapToolKind(event.toolName) as "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other",
              status: "in_progress",
            },
          });
        } else if (event.type === "tool_execution_end") {
          await ctx.client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: event.toolCallId,
              status: event.result.isError ? "failed" : "completed",
              content: [
                {
                  type: "content" as const,
                  content: { type: "text" as const, text: event.result.content },
                },
              ],
            },
          });
        }
        // All other events ignored (agent_start/end, compaction_*, moa_*, queue_update, agent_settled)
      });

      try {
        const outcome = await agentSession.run({ text: userText, history: acpSession.history });

        if (outcome.ok) {
          acpSession.history = outcome.messages;
          return { stopReason: "end_turn" as const };
        } else if ("aborted" in outcome) {
          acpSession.history = outcome.messages;
          return { stopReason: "cancelled" as const };
        } else {
          // error outcome — error already surfaced via tool_call_update; ACP has no error stop reason
          return { stopReason: "end_turn" as const };
        }
      } finally {
        acpSession.activeRun = null;
      }
    })
    .onNotification(methods.agent.session.cancel, (ctx) => {
      const acpSession = sessions.get(ctx.params.sessionId);
      acpSession?.activeRun?.abort();
    });
};

export const runAcpMode = async (options: AcpModeOptions): Promise<void> => {
  const { session, config, stdin, stdout, extensionRunner } = options;
  const agentApp = createAcpApp({ session, config, ...(extensionRunner !== undefined ? { extensionRunner } : {}) });

  // Convert Node streams to web streams for the ACP SDK ndjson transport
  const output = Writable.toWeb(stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(stdin) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  const connection = agentApp.connect(stream);
  await connection.closed;
};

const extractText = (blocks: readonly ContentBlock[]): string =>
  blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "resource") {
        const res = block.resource;
        if ("text" in res) return `file: ${res.text}`;
        return "";
      }
      return "";
    })
    .join("\n")
    .trim();

const buildToolLabel = (toolName: string, args: unknown): string => {
  if (typeof args === "object" && args !== null) {
    const a = args as Record<string, unknown>;
    if (typeof a["path"] === "string") return `${toolName}: ${a["path"]}`;
    if (typeof a["command"] === "string") return `${toolName}: ${a["command"]}`;
  }
  return toolName;
};
