import type { DevinAssistantContentPart, DevinMessage, DevinProvider } from "widevin";
import { registry } from "../tools/index.js";
import type { ToolContext } from "../tools/index.js";
import { CORRUPTION_MARKER, safeParseToolArgs, shouldParallelizeToolBatch } from "./toolDispatch.js";
import { callDevinWithRecovery } from "./recovery.js";

export type TurnOutcome =
  | { ok: true; messages: readonly DevinMessage[]; assistantText: string }
  | { ok: false; error: unknown };

const MAX_STEPS = 10;
const ENABLED_TOOLSETS = ["file", "terminal"] as const;

type StepResult = { done: true; assistantText: string } | { done: false };

const runStep = async (
  devin: DevinProvider,
  model: string,
  messages: DevinMessage[],
  context: ToolContext,
  allTextParts: string[],
  onDelta?: (delta: string) => void
): Promise<StepResult> => {
  const textParts: string[] = [];
  const rawArgsById = new Map<string, string>();
  const toolOrder: { id: string; name: string }[] = [];

  for await (const event of devin.streamChat({
    model,
    messages,
    tools: registry.getSchemas(ENABLED_TOOLSETS),
    systemPrompt: [
      "You are Railgun, a helpful assistant with access to tools for reading and writing files, listing directories, and running shell commands."
    ]
  })) {
    if (event.type === "text_delta") {
      textParts.push(event.delta);
      onDelta?.(event.delta);
    }
    if (event.type === "toolcall_delta") {
      rawArgsById.set(event.id, (rawArgsById.get(event.id) ?? "") + event.delta);
    }
    if (event.type === "toolcall_end") {
      toolOrder.push({ id: event.id, name: event.name });
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
    return { done: true, assistantText: allTextParts.concat(textParts).join("") };
  }
  allTextParts.push(...textParts);

  for (const call of resolved) {
    if (call.corrupted) {
      messages.push({ role: "tool", toolCallId: call.id, content: CORRUPTION_MARKER, isError: true });
    }
  }

  const validCalls = resolved.filter(
    (c): c is { id: string; name: string; arguments: unknown; corrupted: false } => !c.corrupted
  );

  if (shouldParallelizeToolBatch(validCalls)) {
    const results = await Promise.all(validCalls.map(call => registry.run(call.name, call.arguments, context)));
    validCalls.forEach((call, i) => {
      const result = results[i];
      if (result) messages.push({ role: "tool", toolCallId: call.id, content: result.content, isError: result.isError });
    });
  } else {
    for (const call of validCalls) {
      const result = await registry.run(call.name, call.arguments, context);
      messages.push({ role: "tool", toolCallId: call.id, content: result.content, isError: result.isError });
    }
  }

  return { done: false };
};

export const runTurn = async (
  devin: DevinProvider,
  model: string,
  history: readonly DevinMessage[],
  userText: string,
  confirmShellCommand: (command: string) => Promise<boolean>,
  onDelta?: (delta: string) => void
): Promise<TurnOutcome> => {
  const messages: DevinMessage[] = [...history, { role: "user", content: userText }];
  const allTextParts: string[] = [];
  const context: ToolContext = { confirmShellCommand };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const outcome = await callDevinWithRecovery(() => runStep(devin, model, messages, context, allTextParts, onDelta));
      if (outcome.done) return { ok: true, messages, assistantText: outcome.assistantText };
    }
  } catch (error) {
    return { ok: false, error };
  }

  return { ok: true, messages, assistantText: "(stopped: too many steps)" };
};
