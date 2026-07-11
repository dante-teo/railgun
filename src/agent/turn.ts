import type { DevinAssistantContentPart, DevinMessage, DevinProvider } from "widevin";
import { registry } from "../tools/index.js";
import type { ToolContext } from "../tools/index.js";
import type { TodoStore } from "../tools/todo.js";
import { CORRUPTION_MARKER, safeParseToolArgs, shouldParallelizeToolBatch } from "./toolDispatch.js";
import { callDevinWithRecovery } from "./recovery.js";
import type { IterationBudget } from "./iterationBudget.js";
import { ITERATION_LIMIT_MESSAGE } from "./iterationBudget.js";
import { runCompaction, shouldCompact } from "./compaction.js";
import type { UsageTotals } from "./compaction.js";

export type TurnOutcome =
  | { ok: true; messages: readonly DevinMessage[]; assistantText: string }
  | { ok: false; error: unknown };

const ENABLED_TOOLSETS = ["file", "terminal", "planning"] as const;

type StepResult =
  | { done: true; assistantText: string; usage: UsageTotals | undefined }
  | { done: false; usage: UsageTotals | undefined };

export interface LoopCallbacks {
  onDelta?: (delta: string) => void;
  onToolStart?: (name: string, args: unknown) => void;
  onToolComplete?: (name: string, args: unknown, isError: boolean) => void;
  onCompact?: () => void;
}

export interface RunTurnOptions {
  todoStore?: TodoStore;
}

const runStep = async (
  devin: DevinProvider,
  model: string,
  systemPrompt: readonly string[],
  messages: DevinMessage[],
  context: ToolContext,
  allTextParts: string[],
  callbacks?: LoopCallbacks
): Promise<StepResult> => {
  const textParts: string[] = [];
  const rawArgsById = new Map<string, string>();
  const toolOrder: { id: string; name: string }[] = [];
  const todoInjection = context.todoStore?.formatForInjection();
  const prompt = todoInjection && todoInjection.length > 0 ? [...systemPrompt, todoInjection] : systemPrompt;
  let lastUsage: UsageTotals | undefined;

  for await (const event of devin.streamChat({
    model,
    messages,
    tools: registry.getSchemas(ENABLED_TOOLSETS),
    systemPrompt: prompt
  })) {
    if (event.type === "text_delta") {
      textParts.push(event.delta);
      callbacks?.onDelta?.(event.delta);
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

  const assistantParts: DevinAssistantContentPart[] = [];
  if (textParts.length > 0) assistantParts.push({ type: "text", text: textParts.join("") });

  const resolved = toolOrder.map(({ id, name }) => {
    const parsed = safeParseToolArgs(rawArgsById.get(id) ?? "");
    assistantParts.push({ type: "toolCall", id, name, arguments: parsed.ok ? parsed.args : {} });
    return parsed.ok
      ? { id, name, arguments: parsed.args, corrupted: false as const }
      : { id, name, corrupted: true as const };
  });

  messages.push({ role: "assistant", content: assistantParts });

  if (resolved.length === 0) {
    return { done: true, assistantText: allTextParts.concat(textParts).join(""), usage: lastUsage };
  }
  allTextParts.push(...textParts);

  for (const call of resolved) {
    if (call.corrupted) {
      callbacks?.onToolStart?.(call.name, {});
      callbacks?.onToolComplete?.(call.name, {}, true);
      messages.push({ role: "tool", toolCallId: call.id, content: CORRUPTION_MARKER, isError: true });
    }
  }

  const validCalls = resolved.filter(
    (c): c is { id: string; name: string; arguments: unknown; corrupted: false } => !c.corrupted
  );

  if (shouldParallelizeToolBatch(validCalls)) {
    callbacks?.onToolStart?.("__batch__", { count: validCalls.length });
    const results = await Promise.all(validCalls.map(call => registry.run(call.name, call.arguments, context)));
    validCalls.forEach((call, i) => {
      const result = results[i];
      if (result) messages.push({ role: "tool", toolCallId: call.id, content: result.content, isError: result.isError });
    });
    callbacks?.onToolComplete?.("__batch__", { count: validCalls.length }, false);
  } else {
    for (const call of validCalls) {
      callbacks?.onToolStart?.(call.name, call.arguments);
      const result = await registry.run(call.name, call.arguments, context);
      callbacks?.onToolComplete?.(call.name, call.arguments, result.isError);
      messages.push({ role: "tool", toolCallId: call.id, content: result.content, isError: result.isError });
    }
  }

  return { done: false, usage: lastUsage };
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
  callbacks?: LoopCallbacks,
  options?: RunTurnOptions
): Promise<TurnOutcome> => {
  const messages: DevinMessage[] = [...history, { role: "user", content: userText }];
  const allTextParts: string[] = [];
  const context: ToolContext = options?.todoStore
    ? { confirmShellCommand, todoStore: options.todoStore }
    : { confirmShellCommand };
  let compactedThisRound = false;
  const compress = async (): Promise<void> => {
    const result = await runCompaction(devin, model, systemPrompt, messages);
    messages.length = 0;
    messages.push(...result.messages);
    compactedThisRound = true;
    callbacks?.onCompact?.();
  };

  try {
    while (iterationBudget.consume()) {
      compactedThisRound = false;
      const outcome = await callDevinWithRecovery(
        () => runStep(devin, model, systemPrompt, messages, context, allTextParts, callbacks),
        compress
      );
      if (outcome.done) return { ok: true, messages, assistantText: outcome.assistantText };
      if (!compactedThisRound && shouldCompact(outcome.usage, contextWindow)) await compress();
    }
  } catch (error) {
    return { ok: false, error };
  }

  messages.push({ role: "assistant", content: [{ type: "text", text: ITERATION_LIMIT_MESSAGE }] });
  return { ok: true, messages, assistantText: ITERATION_LIMIT_MESSAGE };
};
