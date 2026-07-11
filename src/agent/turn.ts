import type { DevinAssistantContentPart, DevinMessage, DevinProvider } from "widevin";
import { registry } from "../tools/index.js";
import type { ToolContext, ClarifyCallback } from "../tools/index.js";
import type { TodoStore } from "../tools/todo.js";
import type { CommandApprovalMode } from "../security/commandApproval.js";
import { CORRUPTION_MARKER, safeParseToolArgs, shouldParallelizeToolBatch } from "./toolDispatch.js";
import { callDevinWithRecovery } from "./recovery.js";
import type { IterationBudget } from "./iterationBudget.js";
import { ITERATION_LIMIT_MESSAGE } from "./iterationBudget.js";
import { runCompaction, shouldCompact } from "./compaction.js";
import type { UsageTotals } from "./compaction.js";
import type { AgentEvent, ToolResult } from "./events.js";

export type TurnOutcome =
  | { ok: true; messages: readonly DevinMessage[]; assistantText: string }
  | { ok: false; aborted: true; messages: readonly DevinMessage[]; assistantText: string; cancelledQueued: number }
  | { ok: false; error: unknown };

export const STOPPED_BY_USER = "[stopped by user]";

const ENABLED_TOOLSETS = ["file", "terminal", "planning", "clarify"] as const;

type StepResult =
  | { done: true; assistantText: string; usage: UsageTotals | undefined; message: DevinMessage; toolResults: readonly ToolResult[] }
  | { done: false; usage: UsageTotals | undefined; message: DevinMessage; toolResults: readonly ToolResult[] };

export interface RunTurnOptions {
  todoStore?: TodoStore;
  clarifyCallback?: ClarifyCallback;
  signal?: AbortSignal;
  takeSteer?: () => string | undefined;
  takeFollowUps?: () => readonly string[];
  clearQueues?: () => number;
  checkpointGuard?: { beforeMutation: () => void };
  commandApprovalMode?: CommandApprovalMode;
  sessionApprovals?: Set<string>;
  reviewerModel?: string;
}

const pushMessage = async (
  messages: DevinMessage[],
  doEmit: (event: AgentEvent) => Promise<void>,
  message: DevinMessage
): Promise<void> => {
  messages.push(message);
  await doEmit({ type: "message_start", message });
  await doEmit({ type: "message_end", message });
};

const runStep = async (
  devin: DevinProvider,
  model: string,
  systemPrompt: readonly string[],
  messages: DevinMessage[],
  context: ToolContext,
  allTextParts: string[],
  doEmit: (event: AgentEvent) => Promise<void>
): Promise<StepResult> => {
  const textParts: string[] = [];
  const rawArgsById = new Map<string, string>();
  const toolOrder: { id: string; name: string }[] = [];
  const todoInjection = context.todoStore?.formatForInjection();
  const prompt = todoInjection && todoInjection.length > 0 ? [...systemPrompt, todoInjection] : systemPrompt;
  let lastUsage: UsageTotals | undefined;

  await doEmit({ type: "message_start", message: { role: "assistant", content: [] } });

  try {
    for await (const event of devin.streamChat({
      model,
      messages,
      tools: registry.getSchemas(ENABLED_TOOLSETS),
      systemPrompt: prompt,
      signal: context.signal,
    })) {
      if (event.type !== "usage" && event.type !== "done") {
        await doEmit({ type: "message_update", streamEvent: event });
      }
      if (event.type === "text_delta") {
        textParts.push(event.delta);
      }
      if (event.type === "toolcall_delta") {
        rawArgsById.set(event.id, (rawArgsById.get(event.id) ?? "") + event.delta);
      }
      if (event.type === "toolcall_end") {
        toolOrder.push({ id: event.id, name: event.name });
      }
      if (event.type === "usage") {
        lastUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      }
    }
  } catch (error) {
    const partialText = textParts.join("");
    if (context.signal.aborted && partialText !== "") {
      messages.push({ role: "assistant", content: [{ type: "text", text: partialText }] });
      allTextParts.push(partialText);
    }
    await doEmit({
      type: "message_end",
      message: partialText !== ""
        ? { role: "assistant", content: [{ type: "text", text: partialText }] }
        : { role: "assistant", content: [] },
    });
    throw error;
  }

  const assistantParts: DevinAssistantContentPart[] = [];
  if (textParts.length > 0) assistantParts.push({ type: "text", text: textParts.join("") });

  const resolved = toolOrder.map(({ id, name }) => {
    const parsed = safeParseToolArgs(rawArgsById.get(id) ?? "");
    assistantParts.push({ type: "toolCall", id, name, arguments: parsed.ok ? parsed.args : {} });
    return parsed.ok
      ? { id, name, arguments: parsed.args, corrupted: false as const }
      : { id, name, corrupted: true as const };
  });

  const assistantMessage: DevinMessage = { role: "assistant", content: assistantParts };
  messages.push(assistantMessage);
  await doEmit({ type: "message_end", message: assistantMessage });

  const toolResults: ToolResult[] = [];

  if (resolved.length === 0) {
    allTextParts.push(...textParts);
    return { done: true, assistantText: allTextParts.join(""), usage: lastUsage, message: assistantMessage, toolResults };
  }
  allTextParts.push(...textParts);

  for (const call of resolved) {
    if (call.corrupted) {
      await doEmit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: {} });
      const result: ToolResult = { toolCallId: call.id, content: CORRUPTION_MARKER, isError: true };
      await doEmit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result });
      const toolMessage: DevinMessage = { role: "tool", toolCallId: call.id, content: CORRUPTION_MARKER, isError: true };
      await pushMessage(messages, doEmit, toolMessage);
      toolResults.push(result);
    }
  }

  const validCalls = resolved.filter(
    (c): c is { id: string; name: string; arguments: unknown; corrupted: false } => !c.corrupted
  );

  if (shouldParallelizeToolBatch(validCalls)) {
    for (const call of validCalls) {
      await doEmit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    }
    const results = await Promise.all(validCalls.map(async call => {
      if (context.signal.aborted) return { result: { content: STOPPED_BY_USER, isError: true }, completed: false };
      const result = await registry.run(call.name, call.arguments, context);
      return { result, completed: !context.signal.aborted };
    }));
    for (const [i, call] of validCalls.entries()) {
      const settled = results[i];
      if (settled) {
        const outcome = settled.completed ? settled.result : { content: STOPPED_BY_USER, isError: true };
        const result: ToolResult = { toolCallId: call.id, content: outcome.content, isError: outcome.isError };
        await doEmit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result });
        const toolMessage: DevinMessage = { role: "tool", toolCallId: call.id, content: result.content, isError: result.isError };
        await pushMessage(messages, doEmit, toolMessage);
        toolResults.push(result);
      }
    }
  } else {
    for (const call of validCalls) {
      if (context.signal.aborted) {
        const toolMessage: DevinMessage = { role: "tool", toolCallId: call.id, content: STOPPED_BY_USER, isError: true };
        await pushMessage(messages, doEmit, toolMessage);
        toolResults.push({ toolCallId: call.id, content: STOPPED_BY_USER, isError: true });
        continue;
      }
      await doEmit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
      const result = await registry.run(call.name, call.arguments, context);
      const toolResult: ToolResult = { toolCallId: call.id, content: result.content, isError: result.isError };
      await doEmit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: toolResult });
      const toolMessage: DevinMessage = { role: "tool", toolCallId: call.id, content: result.content, isError: result.isError };
      await pushMessage(messages, doEmit, toolMessage);
      toolResults.push(toolResult);
    }
  }

  return { done: false, usage: lastUsage, message: assistantMessage, toolResults };
};

export const runTurn = async (
  devin: DevinProvider,
  model: string,
  contextWindow: number,
  systemPrompt: readonly string[],
  history: readonly DevinMessage[],
  userText: string,
  iterationBudget: IterationBudget,
  confirmShellCommand: (command: string) => Promise<boolean>,
  emit?: (event: AgentEvent) => Promise<void>,
  options?: RunTurnOptions
): Promise<TurnOutcome> => {
  const doEmit = emit ?? (async () => {});
  const initialUserMessage: DevinMessage = { role: "user", content: userText };
  const messages: DevinMessage[] = [...history, initialUserMessage];
  const allTextParts: string[] = [];
  const signal = options?.signal ?? new AbortController().signal;
  const context: ToolContext = {
    confirmShellCommand,
    signal,
    ...(options?.todoStore !== undefined ? { todoStore: options.todoStore } : {}),
    ...(options?.clarifyCallback !== undefined ? { clarifyCallback: options.clarifyCallback } : {}),
    ...(options?.checkpointGuard ? { checkpointGuard: options.checkpointGuard } : {}),
    commandApprovalMode: options?.commandApprovalMode ?? "manual",
    // Note: callers that omit sessionApprovals get an ephemeral Set scoped to this turn;
    // session-approval persistence requires the caller to supply and retain the same Set across turns.
    sessionApprovals: options?.sessionApprovals ?? new Set<string>(),
    devin,
    ...(options?.reviewerModel !== undefined ? { reviewerModel: options.reviewerModel } : {}),
    ...(options?.todoStore ? { todoStore: options.todoStore } : {}),
  };
  let compactedThisRound = false;
  let turnEndedThisAttempt = false;
  const compress = async (reason: "threshold" | "overflow"): Promise<void> => {
    await doEmit({ type: "compaction_start", reason });
    const result = await runCompaction(devin, model, systemPrompt, messages, signal);
    messages.length = 0;
    messages.push(...result.messages);
    compactedThisRound = true;
    await doEmit({ type: "compaction_end", reason });
  };

  await doEmit({ type: "agent_start" });
  await doEmit({ type: "message_start", message: initialUserMessage });
  await doEmit({ type: "message_end", message: initialUserMessage });

  try {
    while (iterationBudget.consume()) {
      compactedThisRound = false;
      turnEndedThisAttempt = false;
      await doEmit({ type: "turn_start" });
      const outcome = await callDevinWithRecovery(
        () => runStep(devin, model, systemPrompt, messages, context, allTextParts, doEmit),
        () => compress("overflow")
      );
      await doEmit({ type: "turn_end", message: outcome.message, toolResults: outcome.toolResults });
      turnEndedThisAttempt = true;
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const steer = options?.takeSteer?.();
      if (steer !== undefined) {
        const steerMessage: DevinMessage = { role: "user", content: steer };
        await pushMessage(messages, doEmit, steerMessage);
        continue;
      }
      if (outcome.done) {
        const followUps = options?.takeFollowUps?.() ?? [];
        if (followUps.length === 0) {
          await doEmit({ type: "agent_end", messages });
          return { ok: true, messages, assistantText: outcome.assistantText };
        }
        for (const text of followUps) {
          const followUpMessage: DevinMessage = { role: "user", content: text };
          await pushMessage(messages, doEmit, followUpMessage);
        }
        continue;
      }
      if (!compactedThisRound && shouldCompact(outcome.usage, contextWindow)) await compress("threshold");
    }
  } catch (error) {
    if (signal.aborted) {
      const cancelledQueued = options?.clearQueues?.() ?? 0;
      const partialText = allTextParts.join("");
      if (!turnEndedThisAttempt) {
        if (messages.at(-1)?.role === "user") {
          const closer: DevinMessage = { role: "assistant", content: [] };
          await pushMessage(messages, doEmit, closer);
        }
        await doEmit({ type: "turn_end", message: messages.at(-1)!, toolResults: [] });
      }
      await doEmit({ type: "agent_end", messages });
      return { ok: false, aborted: true, messages, assistantText: partialText, cancelledQueued };
    }
    return { ok: false, error };
  }

  const limitMessage: DevinMessage = { role: "assistant", content: [{ type: "text", text: ITERATION_LIMIT_MESSAGE }] };
  await pushMessage(messages, doEmit, limitMessage);
  await doEmit({ type: "agent_end", messages });
  return { ok: true, messages, assistantText: ITERATION_LIMIT_MESSAGE };
};
