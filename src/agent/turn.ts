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
  | { ok: false; aborted: true; messages: readonly DevinMessage[]; assistantText: string; cancelledQueued: number }
  | { ok: false; error: unknown };

export const STOPPED_BY_USER = "[stopped by user]";

const ENABLED_TOOLSETS = ["file", "terminal", "planning"] as const;

type StepResult =
  | { done: true; assistantText: string; usage: UsageTotals | undefined }
  | { done: false; usage: UsageTotals | undefined };

export interface LoopCallbacks {
  onDelta?: (delta: string) => void;
  onToolStart?: (name: string, args: unknown) => void;
  onToolComplete?: (name: string, args: unknown, isError: boolean) => void;
  onCompact?: () => void;
  onQueueInjected?: (text: string, kind: "steer" | "followUp") => void;
  onAbort?: (cancelledQueued: number) => void;
}

export interface RunTurnOptions {
  todoStore?: TodoStore;
  signal?: AbortSignal;
  takeSteer?: () => string | undefined;
  takeFollowUps?: () => readonly string[];
  clearQueues?: () => number;
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

  try {
    for await (const event of devin.streamChat({
      model,
      messages,
      tools: registry.getSchemas(ENABLED_TOOLSETS),
      systemPrompt: prompt,
      signal: context.signal,
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
  } catch (error) {
    const partialText = textParts.join("");
    if (context.signal.aborted && partialText !== "") {
      messages.push({ role: "assistant", content: [{ type: "text", text: partialText }] });
      allTextParts.push(partialText);
    }
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

  messages.push({ role: "assistant", content: assistantParts });

  if (resolved.length === 0) {
    allTextParts.push(...textParts);
    return { done: true, assistantText: allTextParts.join(""), usage: lastUsage };
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
    const results = await Promise.all(validCalls.map(async call => {
      if (context.signal.aborted) return { result: { content: STOPPED_BY_USER, isError: true }, completed: false };
      const result = await registry.run(call.name, call.arguments, context);
      return { result, completed: !context.signal.aborted };
    }));
    validCalls.forEach((call, i) => {
      const settled = results[i];
      if (settled) {
        const result = settled.completed ? settled.result : { content: STOPPED_BY_USER, isError: true };
        messages.push({ role: "tool", toolCallId: call.id, content: result.content, isError: result.isError });
      }
    });
    callbacks?.onToolComplete?.("__batch__", { count: validCalls.length }, false);
  } else {
    for (const call of validCalls) {
      if (context.signal.aborted) {
        messages.push({ role: "tool", toolCallId: call.id, content: STOPPED_BY_USER, isError: true });
        continue;
      }
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
  const signal = options?.signal ?? new AbortController().signal;
  const context: ToolContext = options?.todoStore
    ? { confirmShellCommand, signal, todoStore: options.todoStore }
    : { confirmShellCommand, signal };
  let compactedThisRound = false;
  const compress = async (): Promise<void> => {
    const result = await runCompaction(devin, model, systemPrompt, messages, signal);
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
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const steer = options?.takeSteer?.();
      if (steer !== undefined) {
        messages.push({ role: "user", content: steer });
        callbacks?.onQueueInjected?.(steer, "steer");
        continue;
      }
      if (outcome.done) {
        const followUps = options?.takeFollowUps?.() ?? [];
        if (followUps.length === 0) return { ok: true, messages, assistantText: outcome.assistantText };
        followUps.forEach(text => {
          messages.push({ role: "user", content: text });
          callbacks?.onQueueInjected?.(text, "followUp");
        });
        continue;
      }
      if (!compactedThisRound && shouldCompact(outcome.usage, contextWindow)) await compress();
    }
  } catch (error) {
    if (signal.aborted) {
      const cancelledQueued = options?.clearQueues?.() ?? 0;
      callbacks?.onAbort?.(cancelledQueued);
      const partialText = allTextParts.join("");
      if (messages.at(-1)?.role === "user") messages.push({ role: "assistant", content: [] });
      return { ok: false, aborted: true, messages, assistantText: partialText, cancelledQueued };
    }
    return { ok: false, error };
  }

  messages.push({ role: "assistant", content: [{ type: "text", text: ITERATION_LIMIT_MESSAGE }] });
  return { ok: true, messages, assistantText: ITERATION_LIMIT_MESSAGE };
};
