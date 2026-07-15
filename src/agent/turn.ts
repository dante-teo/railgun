import type { DevinAssistantContentPart, DevinMessage, DevinProvider } from "widevin";
import { registry } from "../tools/index.js";
import type { ToolContext, ClarifyCallback } from "../tools/index.js";
import type { TodoStore } from "../tools/todo.js";
import type { MemoryStore } from "../persistence/memoryStore.js";
import type { NoteStore } from "../persistence/noteStore.js";
import type { CommandApprovalMode } from "../security/commandApproval.js";
import { CORRUPTION_MARKER, safeParseToolArgs, shouldParallelizeToolBatch } from "./toolDispatch.js";
import { callDevinWithRecovery } from "./recovery.js";
import type { IterationBudget } from "./iterationBudget.js";
import { ITERATION_LIMIT_MESSAGE } from "./iterationBudget.js";
import { runCompaction, shouldCompact } from "./compaction.js";
import type { UsageTotals } from "./compaction.js";
import type { AgentEvent, ToolResult } from "./events.js";
import type { ExtensionRunner } from "../extensions/runner.js";
import type { MoAPreset, ReferenceCallbacks } from "./moa.js";
import { runReferences, buildAggregatorGuidance } from "./moa.js";
import { PRIMARY_TOOLSETS } from "../tools/toolsets.js";
import { DEFAULT_OPERATION_TIMEOUT_MS, runBoundedOperation } from "../asyncOperation.js";
import { initialProgressState, planToolCalls, recordToolResults } from "./progress.js";
import type { ProgressState } from "./progress.js";
import type { RuntimeContext } from "../runtime.js";
import { createRuntimeContext } from "../runtime.js";

export type TurnOutcome =
  | { ok: true; messages: readonly DevinMessage[]; assistantText: string; stopReason?: "iteration_limit" }
  | { ok: false; aborted: true; messages: readonly DevinMessage[]; assistantText: string; cancelledQueued: number }
  | { ok: false; error: unknown };

export const STOPPED_BY_USER = "[stopped by user]";

const ENABLED_TOOLSETS = PRIMARY_TOOLSETS;

type StepResult =
  | { done: true; assistantText: string; usage: UsageTotals | undefined; message: DevinMessage; toolResults: readonly ToolResult[] }
  | { done: false; usage: UsageTotals | undefined; message: DevinMessage; toolResults: readonly ToolResult[]; progressState: ProgressState; guidance?: string };

export interface RunTurnOptions {
  todoStore?: TodoStore;
  clarifyCallback?: ClarifyCallback;
  signal?: AbortSignal;
  takeSteer?: () => string | undefined;
  takeFollowUp?: () => string | undefined;
  /** @deprecated Prefer takeFollowUp to preserve assistant boundaries. */
  takeFollowUps?: () => readonly string[];
  clearQueues?: () => number;
  commandApprovalMode?: CommandApprovalMode;
  sessionApprovals?: Set<string>;
  reviewerModel?: string;
  extensionRunner?: ExtensionRunner;
  memoryStore?: MemoryStore;
  noteStore?: NoteStore;
  moaPreset?: MoAPreset;
  onTurnEnd?: (messages: readonly DevinMessage[], pushMessage: (msg: DevinMessage) => void) => Promise<void> | void;
  model?: string;
  contextWindow?: number;
  delegationDepth?: number;
  enabledToolsets?: readonly string[];
  operationTimeoutMs?: number;
  cron?: boolean;
  runtime?: RuntimeContext;
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
  doEmit: (event: AgentEvent) => Promise<void>,
  extensionRunner?: ExtensionRunner,
  enabledToolsets: readonly string[] = ENABLED_TOOLSETS,
  progressState: ProgressState = initialProgressState(),
  cron = false,
  finalizing = false,
): Promise<StepResult> => {
  const textParts: string[] = [];
  const rawArgsById = new Map<string, string>();
  const toolOrder: { id: string; name: string }[] = [];
  const todoInjection = context.todoStore?.formatForInjection();
  const prompt = todoInjection && todoInjection.length > 0 ? [...systemPrompt, todoInjection] : systemPrompt;
  let lastUsage: UsageTotals | undefined;

  await doEmit({ type: "message_start", message: { role: "assistant", content: [] } });

  try {
    let flushAlreadyProduced = context.signal.aborted;
    await runBoundedOperation(context.signal, context.operationTimeoutMs, "Provider stream", async scopedSignal => {
      for await (const event of devin.streamChat({
        model,
        messages,
        tools: registry.getSchemas(enabledToolsets).filter(tool => !(finalizing && tool.name === "web_search")),
        systemPrompt: prompt,
        signal: scopedSignal,
      })) {
        if (scopedSignal.aborted) {
          if (!flushAlreadyProduced) break;
          flushAlreadyProduced = false;
        }
        if (event.type !== "usage" && event.type !== "done") {
          await doEmit({ type: "message_update", streamEvent: event });
        }
        if (event.type === "text_delta") {
          textParts.push(event.delta);
          allTextParts.push(event.delta);
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
    }, { flushAlreadyProduced: true });
  } catch (error) {
    const partialText = textParts.join("");
    if (context.signal.aborted && partialText !== "") {
      messages.push({ role: "assistant", content: [{ type: "text", text: partialText }] });
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
    return { done: true, assistantText: allTextParts.join(""), usage: lastUsage, message: assistantMessage, toolResults };
  }

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

  const parsedCalls = resolved.filter(
    (c): c is { id: string; name: string; arguments: unknown; corrupted: false } => !c.corrupted
  );
  const planned = planToolCalls(
    finalizing ? { ...progressState, consecutiveSearches: Math.max(10, progressState.consecutiveSearches) } : progressState,
    parsedCalls,
    cron,
  );
  const blocked = planned.decisions.filter(decision => !decision.allowed);
  for (const decision of blocked) {
    const content = decision.guidance ?? "Blocked non-progressing tool call.";
    await doEmit({ type: "tool_execution_start", toolCallId: decision.call.id, toolName: decision.call.name, args: decision.call.arguments });
    const result: ToolResult = { toolCallId: decision.call.id, content, isError: true };
    await doEmit({ type: "tool_execution_end", toolCallId: decision.call.id, toolName: decision.call.name, result });
    await pushMessage(messages, doEmit, { role: "tool", toolCallId: decision.call.id, content, isError: true });
    toolResults.push(result);
  }
  const validCalls = planned.decisions.filter(decision => decision.allowed).map(decision => decision.call);

  if (shouldParallelizeToolBatch(validCalls)) {
    for (const call of validCalls) {
      await doEmit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    }
    const results = await Promise.all(validCalls.map(async call => {
      if (context.signal.aborted) return { result: { content: STOPPED_BY_USER, isError: true }, completed: false };
      try {
        if (extensionRunner) {
          const before = await runBoundedOperation(context.signal, context.operationTimeoutMs, `Extension tool_call hook for "${call.name}"`, () => extensionRunner.emitToolCall({
            type: "tool_call",
            toolCallId: call.id,
            toolName: call.name,
            input: call.arguments as Record<string, unknown>,
          }));
          if (before.block) {
            return { result: { content: `Blocked by extension: ${before.reason ?? ""}`, isError: true }, completed: true };
          }
        }
        const start = Date.now();
        const timeoutMs = call.name === "clarify" || call.name === "run_shell_command" ? undefined : context.operationTimeoutMs;
        const raw = await runBoundedOperation(context.signal, timeoutMs, `Tool "${call.name}"`, scopedSignal => registry.run(call.name, call.arguments, { ...context, signal: scopedSignal }));
        const durationMs = Date.now() - start;
        let content = raw.content;
        let isError = raw.isError;
        if (extensionRunner) {
          const after = await runBoundedOperation(context.signal, context.operationTimeoutMs, `Extension tool_result hook for "${call.name}"`, () => extensionRunner.emitToolResult({
            type: "tool_result",
            toolCallId: call.id,
            toolName: call.name,
            input: call.arguments as Record<string, unknown>,
            content,
            isError,
            durationMs,
          }));
          if (after.content !== undefined) content = after.content;
          if (after.isError !== undefined) isError = after.isError;
        }
        return { result: { content, isError }, completed: !context.signal.aborted };
      } catch (err) {
        return { result: { content: `Error: ${String(err)}`, isError: true }, completed: true };
      }
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
      try {
        if (extensionRunner) {
          const before = await runBoundedOperation(context.signal, context.operationTimeoutMs, `Extension tool_call hook for "${call.name}"`, () => extensionRunner.emitToolCall({
            type: "tool_call",
            toolCallId: call.id,
            toolName: call.name,
            input: call.arguments as Record<string, unknown>,
          }));
          if (before.block) {
            const blocked = { content: `Blocked by extension: ${before.reason ?? ""}`, isError: true };
            const blockedResult: ToolResult = { toolCallId: call.id, ...blocked };
            await doEmit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: blockedResult });
            await pushMessage(messages, doEmit, { role: "tool", toolCallId: call.id, ...blocked });
            toolResults.push(blockedResult);
            continue;
          }
        }
        const start = Date.now();
        const timeoutMs = call.name === "clarify" || call.name === "run_shell_command" ? undefined : context.operationTimeoutMs;
        const raw = await runBoundedOperation(context.signal, timeoutMs, `Tool "${call.name}"`, scopedSignal => registry.run(call.name, call.arguments, { ...context, signal: scopedSignal }));
        const durationMs = Date.now() - start;
        let content = raw.content;
        let isError = raw.isError;
        if (extensionRunner) {
          const after = await runBoundedOperation(context.signal, context.operationTimeoutMs, `Extension tool_result hook for "${call.name}"`, () => extensionRunner.emitToolResult({
            type: "tool_result",
            toolCallId: call.id,
            toolName: call.name,
            input: call.arguments as Record<string, unknown>,
            content,
            isError,
            durationMs,
          }));
          if (after.content !== undefined) content = after.content;
          if (after.isError !== undefined) isError = after.isError;
        }
        const toolResult: ToolResult = { toolCallId: call.id, content, isError };
        await doEmit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: toolResult });
        const toolMessage: DevinMessage = { role: "tool", toolCallId: call.id, content, isError };
        await pushMessage(messages, doEmit, toolMessage);
        toolResults.push(toolResult);
      } catch (err) {
        const errContent = `Error: ${String(err)}`;
        const errResult: ToolResult = { toolCallId: call.id, content: errContent, isError: true };
        await doEmit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: errResult });
        await pushMessage(messages, doEmit, { role: "tool", toolCallId: call.id, content: errContent, isError: true });
        toolResults.push(errResult);
      }
    }
  }

  const resultById = new Map(toolResults.map(result => [result.toolCallId, result]));
  const order = new Map(resolved.map((call, index) => [call.id, index]));
  toolResults.sort((a, b) => (order.get(a.toolCallId) ?? 0) - (order.get(b.toolCallId) ?? 0));
  const toolMessages = messages.splice(messages.indexOf(assistantMessage) + 1)
    .sort((a, b) => a.role === "tool" && b.role === "tool"
      ? (order.get(a.toolCallId) ?? 0) - (order.get(b.toolCallId) ?? 0)
      : 0);
  messages.push(...toolMessages);
  const executedResults = planned.decisions
    .filter(decision => decision.allowed)
    .map(decision => resultById.get(decision.call.id))
    .filter((result): result is ToolResult => result !== undefined);
  const progress = recordToolResults(planned.state, planned.decisions, executedResults);
  const guidance = progress.guidance ?? planned.decisions.find(decision => decision.guidance)?.guidance;
  return {
    done: false, usage: lastUsage, message: assistantMessage, toolResults,
    progressState: progress.state,
    ...(guidance ? { guidance } : {}),
  };
};

const synthesizeAfterIterationLimit = async (
  devin: DevinProvider,
  model: string,
  systemPrompt: readonly string[],
  messages: readonly DevinMessage[],
  signal: AbortSignal,
  operationTimeoutMs: number,
): Promise<string> => {
  const text: string[] = [];
  const finalPrompt = [
    ...systemPrompt,
    "Iteration budget exhausted. Make one tool-free final response now. Summarize useful findings, completed work, and blockers honestly. Do not claim completion for missing artifacts.",
  ];
  await runBoundedOperation(signal, operationTimeoutMs, "Iteration-limit synthesis", async scopedSignal => {
    for await (const event of devin.streamChat({ model, messages, tools: [], systemPrompt: finalPrompt, signal: scopedSignal })) {
      if (event.type === "text_delta") text.push(event.delta);
    }
  });
  return text.join("").trim() || ITERATION_LIMIT_MESSAGE;
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
  const effectiveModel = options?.moaPreset?.aggregator.model ?? model;
  const effectiveToolsets = options?.enabledToolsets ?? ENABLED_TOOLSETS;
  const initialUserMessage: DevinMessage = { role: "user", content: userText };
  const messages: DevinMessage[] = [...history, initialUserMessage];
  const allTextParts: string[] = [];
  const signal = options?.signal ?? new AbortController().signal;
  const context: ToolContext = {
    confirmShellCommand,
    signal,
    ...(options?.todoStore !== undefined ? { todoStore: options.todoStore } : {}),
    ...(options?.clarifyCallback !== undefined ? { clarifyCallback: options.clarifyCallback } : {}),
    commandApprovalMode: options?.commandApprovalMode ?? "manual",
    // Note: callers that omit sessionApprovals get an ephemeral Set scoped to this turn;
    // session-approval persistence requires the caller to supply and retain the same Set across turns.
    sessionApprovals: options?.sessionApprovals ?? new Set<string>(),
    devin,
    ...(options?.reviewerModel !== undefined ? { reviewerModel: options.reviewerModel } : {}),
    ...(options?.memoryStore !== undefined ? { memoryStore: options.memoryStore } : {}),
    ...(options?.noteStore !== undefined ? { noteStore: options.noteStore } : {}),
    model: options?.model ?? model,
    contextWindow: options?.contextWindow ?? contextWindow,
    delegationDepth: options?.delegationDepth ?? 0,
    emit: doEmit,
    operationTimeoutMs: options?.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    runtime: options?.runtime ?? createRuntimeContext("interactive"),
  };
  let compactedThisRound = false;
  let turnEndedThisAttempt = false;
  let progressState = initialProgressState();
  let finalizationGuidanceInjected = false;
  let legacyFollowUps: readonly string[] = [];
  const takeNextFollowUp = (): string | undefined => {
    if (options?.takeFollowUp !== undefined) return options.takeFollowUp();
    const [next, ...rest] = legacyFollowUps.length > 0
      ? legacyFollowUps
      : options?.takeFollowUps?.() ?? [];
    legacyFollowUps = rest;
    return next;
  };
  const compress = async (reason: "threshold" | "overflow"): Promise<void> => {
    await doEmit({ type: "compaction_start", reason });
    const result = await runBoundedOperation(signal, context.operationTimeoutMs, "Compaction model work", scopedSignal =>
      runCompaction(devin, model, systemPrompt, messages, scopedSignal));
    messages.length = 0;
    messages.push(...result.messages);
    compactedThisRound = true;
    await doEmit({ type: "compaction_end", reason });
  };

  await doEmit({ type: "agent_start" });
  await doEmit({ type: "message_start", message: initialUserMessage });
  await doEmit({ type: "message_end", message: initialUserMessage });

  const privateGuidanceMessages = new Set<DevinMessage>();
  if (options?.moaPreset) {
    const preset = options.moaPreset;
    const callbacks: ReferenceCallbacks = {
      onStart: async (index, count, model) => doEmit({ type: "moa_reference_start", index, count, model }),
      onEnd: async (index, model, text) => doEmit({ type: "moa_reference_end", index, model, text }),
    };
    const refs = await runBoundedOperation(signal, context.operationTimeoutMs, "Delegated reference model work", scopedSignal =>
      runReferences(devin, preset, messages, scopedSignal, callbacks));
    const guidance = buildAggregatorGuidance(refs);
    await doEmit({ type: "moa_aggregating", aggregator: preset.aggregator.model, refCount: refs.length });
    // Guidance is private context for the aggregator — not a real user message.
    // Skip pushMessage (which emits message_start/end) to keep the event stream clean.
    const guidanceMessage: DevinMessage = { role: "user", content: guidance };
    privateGuidanceMessages.add(guidanceMessage);
    messages.push(guidanceMessage);
  }

  // Strip the private guidance message before returning so it is never persisted in the checkpoint.
  // Compaction rebuilds the messages array entirely, so after compaction the guidance is already gone —
  // the filter is a no-op in that case and safe to call unconditionally.
  const stripGuidance = (msgs: DevinMessage[]): DevinMessage[] =>
    privateGuidanceMessages.size > 0 ? msgs.filter(message => !privateGuidanceMessages.has(message)) : msgs;

  const finishAborted = async (): Promise<Extract<TurnOutcome, { aborted: true }>> => {
    const cancelledQueued = options?.clearQueues?.() ?? 0;
    const partialText = allTextParts.join("");
    if (!turnEndedThisAttempt) {
      if (messages.at(-1)?.role === "user") {
        const closer: DevinMessage = { role: "assistant", content: [] };
        await pushMessage(messages, doEmit, closer);
      }
      await doEmit({ type: "turn_end", message: messages.at(-1)!, toolResults: [] });
    }
    await doEmit({ type: "agent_end", messages: stripGuidance(messages) });
    return { ok: false, aborted: true, messages: stripGuidance(messages), assistantText: partialText, cancelledQueued };
  };

  try {
    while (iterationBudget.consume()) {
      compactedThisRound = false;
      turnEndedThisAttempt = false;
      const finalizing = options?.cron === true && iterationBudget.remaining() < 5;
      if (finalizing && !finalizationGuidanceInjected) {
        const finalizationGuidance: DevinMessage = {
          role: "user",
          content: "Finalization mode: research is closed. Use existing evidence, write every required output using absolute paths, verify the files, and return an honest partial report if data remains unavailable.",
        };
        privateGuidanceMessages.add(finalizationGuidance);
        messages.push(finalizationGuidance);
        finalizationGuidanceInjected = true;
      }
      await doEmit({ type: "turn_start" });
      const outcome = await callDevinWithRecovery(
        () => runStep(devin, effectiveModel, systemPrompt, messages, context, allTextParts, doEmit, options?.extensionRunner, effectiveToolsets, progressState, options?.cron === true, finalizing),
        () => compress("overflow")
      );
      await doEmit({
        type: "turn_end",
        message: outcome.message,
        toolResults: outcome.toolResults,
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      });
      turnEndedThisAttempt = true;
      if (options?.onTurnEnd) {
        await runBoundedOperation(signal, context.operationTimeoutMs, "Turn-end advisor work", () =>
          Promise.resolve(options.onTurnEnd!(messages, (msg: DevinMessage) => messages.push(msg))));
      }
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const steer = options?.takeSteer?.();
      if (steer !== undefined) {
        const steerMessage: DevinMessage = { role: "user", content: steer };
        await pushMessage(messages, doEmit, steerMessage);
        continue;
      }
      if (outcome.done) {
        const followUp = takeNextFollowUp();
        if (followUp === undefined) {
          await doEmit({ type: "agent_end", messages: stripGuidance(messages) });
          return { ok: true, messages: stripGuidance(messages), assistantText: outcome.assistantText };
        }
        const followUpMessage: DevinMessage = { role: "user", content: followUp };
        await pushMessage(messages, doEmit, followUpMessage);
        continue;
      }
      progressState = outcome.progressState;
      if (outcome.guidance) {
        const progressGuidance: DevinMessage = { role: "user", content: outcome.guidance };
        privateGuidanceMessages.add(progressGuidance);
        messages.push(progressGuidance);
      }
      if (!compactedThisRound && shouldCompact(outcome.usage, contextWindow)) await compress("threshold");
    }
  } catch (error) {
    if (signal.aborted) return finishAborted();
    return { ok: false, error };
  }

  let summary: string;
  try {
    summary = await synthesizeAfterIterationLimit(
      devin, effectiveModel, systemPrompt, messages, signal, context.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    );
  } catch {
    if (signal.aborted) return finishAborted();
    summary = ITERATION_LIMIT_MESSAGE;
  }
  const limitMessage: DevinMessage = { role: "assistant", content: [{ type: "text", text: summary }] };
  await pushMessage(messages, doEmit, limitMessage);
  await doEmit({ type: "agent_end", messages: stripGuidance(messages) });
  return { ok: true, messages: stripGuidance(messages), assistantText: summary, stopReason: "iteration_limit" };
};
