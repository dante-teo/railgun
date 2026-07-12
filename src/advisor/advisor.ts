import type { DevinAssistantContentPart, DevinMessage, DevinProvider } from "widevin";
import type { AdvisoryContext } from "./advisoryContext.js";
import type { ToolContext } from "../tools/registry.js";
import { registry } from "../tools/index.js";
import { IterationBudget } from "../agent/iterationBudget.js";

export interface AdvisorConfig {
  readonly model: string;
}

export interface AdvisorRuntime {
  seedFrom(primaryMessages: readonly DevinMessage[]): void;
  onPrimaryTurnEnd(
    primaryMessages: readonly DevinMessage[],
    steer: (text: string) => void,
    /** @deprecated Retained for API compatibility; advisory delivery uses steer. */
    appendToPrimary: (msg: DevinMessage) => void,
  ): Promise<void>;
}

export const ADVISOR_ALLOWED_TOOLS: readonly string[] = ["read_file", "list_directory", "advise"];

const getAdvisorTools = () =>
  ADVISOR_ALLOWED_TOOLS.flatMap(name => {
    const tool = registry.get(name);
    return tool ? [tool.schema] : [];
  });

export const ADVISOR_SYSTEM_PROMPT: readonly string[] = [
  "You are an advisor reviewing another AI agent's work. Your job is to watch for mistakes, missed requirements, and risky decisions.",
  "You have read-only access to the filesystem via read_file and list_directory. Use them to verify claims the primary agent made.",
  "If you spot an issue, call the advise tool ONCE with your most important observation. Use 'blocker' only for clear waste or breakage, 'concern' for likely wrong direction, 'nit' for cleanup suggestions.",
  "If you have no concerns, do nothing — do NOT call advise just to say 'looks good'.",
  "You cannot write files, run commands, or approve anything. You observe and advise only.",
];

export const formatDeltaForAdvisor = (delta: readonly DevinMessage[]): string =>
  delta.map(msg => {
    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? msg.content.slice(0, 500)
        : "[non-text content]";
      return `[User]: ${content}`;
    }
    if (msg.role === "assistant") {
      const parts: string[] = [];
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === "object" && part !== null) {
            const p = part as Record<string, unknown>;
            if (p.type === "text" && typeof p.text === "string") {
              parts.push(p.text);
            } else if (p.type === "toolCall") {
              const argsJson = JSON.stringify(p.arguments ?? {});
              const truncated = argsJson.length > 200 ? argsJson.slice(0, 200) + "…" : argsJson;
              parts.push(`\n  Tool call: ${p.name as string}(${truncated})`);
            }
          }
        }
      } else if (typeof msg.content === "string") {
        parts.push(msg.content);
      }
      return `[Assistant]: ${parts.join("")}`;
    }
    if (msg.role === "tool") {
      const raw = msg.content;
      const text = typeof raw === "string" ? raw : String(raw);
      const content = text.length > 300 ? text.slice(0, 300) + "…" : text;
      return `[Tool ${msg.toolCallId}]: ${content}`;
    }
    return "";
  }).filter(Boolean).join("\n\n");

export const createAdvisorRuntime = (devin: DevinProvider, config: AdvisorConfig): AdvisorRuntime => {
  const history: DevinMessage[] = [];
  let cursor = 0;
  const dedupe = new Set<string>();

  const seedFrom = (primaryMessages: readonly DevinMessage[]): void => {
    cursor = primaryMessages.length;
  };

  const onPrimaryTurnEnd = async (
    primaryMessages: readonly DevinMessage[],
    steer: (text: string) => void,
    appendToPrimary: (msg: DevinMessage) => void,
  ): Promise<void> => {
    try {
      const delta = primaryMessages.slice(cursor);
      cursor = primaryMessages.length;
      if (delta.length === 0) return;

      const guard: AdvisoryContext = { steer, appendToPrimary, dedupe, notesThisUpdate: 0 };

      const advisorToolContext: ToolContext = {
        confirmShellCommand: async () => false,
        signal: new AbortController().signal,
        commandApprovalMode: "manual",
        sessionApprovals: new Set<string>(),
        advisoryContext: guard,
      };

      history.push({ role: "user", content: formatDeltaForAdvisor(delta) });

      const budget = IterationBudget.create(3);

      while (budget.consume()) {
        const textParts: string[] = [];
        const rawArgsById = new Map<string, string>();
        const toolOrder: { id: string; name: string }[] = [];

        for await (const event of devin.streamChat({
          model: config.model,
          messages: history,
          tools: getAdvisorTools(),
          systemPrompt: ADVISOR_SYSTEM_PROMPT,
        })) {
          if (event.type === "text_delta") {
            textParts.push(event.delta);
          } else if (event.type === "toolcall_delta") {
            rawArgsById.set(event.id, (rawArgsById.get(event.id) ?? "") + event.delta);
          } else if (event.type === "toolcall_end") {
            toolOrder.push({ id: event.id, name: event.name });
          }
        }

        const assistantParts: DevinAssistantContentPart[] = [];
        if (textParts.length > 0) {
          assistantParts.push({ type: "text", text: textParts.join("") });
        }

        // Parse args once — used both for the assistant message and tool dispatch.
        const resolvedCalls = toolOrder.map(({ id, name }) => {
          let args: unknown = {};
          try { args = JSON.parse(rawArgsById.get(id) ?? "{}"); } catch { /* malformed — fall back to {} */ }
          return { id, name, args };
        });

        for (const { id, name, args } of resolvedCalls) {
          assistantParts.push({ type: "toolCall", id, name, arguments: args });
        }

        history.push({ role: "assistant", content: assistantParts });

        if (resolvedCalls.length === 0) break;

        for (const { id, name, args } of resolvedCalls) {
          const result = ADVISOR_ALLOWED_TOOLS.includes(name)
            ? await registry.run(name, args, advisorToolContext)
            : { content: "Error: tool not available to advisor", isError: true };
          history.push({ role: "tool", toolCallId: id, content: result.content, isError: result.isError });
        }
      }
    } catch (err) {
      console.error("Advisor error:", err);
    }
  };

  return { seedFrom, onPrimaryTurnEnd };
};
