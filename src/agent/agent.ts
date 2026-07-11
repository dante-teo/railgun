import type { MoAPreset } from "./moa.js";
import type { DevinMessage, DevinProvider } from "widevin";
import type { CommandApprovalMode } from "../security/commandApproval.js";
import type { TodoStore } from "../tools/todo.js";
import type { ClarifyCallback } from "../tools/registry.js";
import { IterationBudget } from "./iterationBudget.js";
import type { TurnOutcome } from "./turn.js";
import { runTurn } from "./turn.js";
import type { AgentEvent, AgentEventListener } from "./events.js";
import { createMessageQueues } from "./queue.js";
import type { ExtensionRunner } from "../extensions/runner.js";
import type { MemoryStore } from "../persistence/memoryStore.js";

export interface AgentDependencies {
  readonly devin: DevinProvider;
  readonly model: string;
  readonly contextWindow: number;
  readonly systemPrompt: readonly string[];
  readonly confirmShellCommand: (command: string) => Promise<boolean>;
  readonly clarifyCallback?: ClarifyCallback;
  readonly todoStore?: TodoStore;
  readonly iterationBudget?: () => IterationBudget;
  readonly checkpointGuard?: { beforeMutation: () => void; resetTurn: () => void };
  readonly commandApprovalMode?: CommandApprovalMode;
  readonly sessionApprovals?: Set<string>;
  readonly reviewerModel?: string;
  readonly extensionRunner?: ExtensionRunner;
  readonly memoryStore?: MemoryStore;
  readonly moaPreset?: MoAPreset;
}

export interface AgentRunInput {
  readonly text: string;
  readonly history?: readonly DevinMessage[];
}

export interface Agent {
  readonly run: (input: string | AgentRunInput) => Promise<TurnOutcome>;
  readonly abort: () => void;
  readonly steer: (text: string) => void;
  readonly followUp: (text: string) => void;
  readonly subscribe: (listener: AgentEventListener) => () => void;
  readonly isRunning: boolean;
}

export const normalizedText = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Queued messages must not be empty");
  return trimmed;
};

export const createAgent = (dependencies: AgentDependencies): Agent => {
  const queues = createMessageQueues();
  const listeners = new Set<AgentEventListener>();
  let controller: AbortController | undefined;

  const processEvents = async (event: AgentEvent): Promise<void> => {
    for (const listener of listeners) {
      try {
        await listener(event);
      } catch (err) {
        console.error("Event listener failed:", err);
      }
    }
  };

  const requireRunning = (): void => {
    if (controller === undefined) throw new Error("Agent is not running");
  };

  const run = async (input: string | AgentRunInput): Promise<TurnOutcome> => {
    if (controller !== undefined) throw new Error("Agent is already running");
    const currentController = new AbortController();
    controller = currentController;
    const normalized = typeof input === "string" ? { text: input, history: [] } : { text: input.text, history: input.history ?? [] };
    try {
      return await runTurn(
        dependencies.devin, dependencies.model, dependencies.contextWindow, dependencies.systemPrompt,
        normalized.history, normalizedText(normalized.text),
        (dependencies.iterationBudget ?? IterationBudget.create)(), dependencies.confirmShellCommand,
        processEvents,
        {
          signal: currentController.signal,
          takeSteer: queues.takeSteer,
          takeFollowUps: queues.takeFollowUps,
          clearQueues: queues.clear,
          ...(dependencies.todoStore !== undefined ? { todoStore: dependencies.todoStore } : {}),
          ...(dependencies.clarifyCallback !== undefined ? { clarifyCallback: dependencies.clarifyCallback } : {}),
          ...(dependencies.checkpointGuard ? { checkpointGuard: dependencies.checkpointGuard } : {}),
          ...(dependencies.commandApprovalMode !== undefined ? { commandApprovalMode: dependencies.commandApprovalMode } : {}),
          ...(dependencies.sessionApprovals !== undefined ? { sessionApprovals: dependencies.sessionApprovals } : {}),
          ...(dependencies.reviewerModel !== undefined ? { reviewerModel: dependencies.reviewerModel } : {}),
          ...(dependencies.extensionRunner ? { extensionRunner: dependencies.extensionRunner } : {}),
          ...(dependencies.memoryStore !== undefined ? { memoryStore: dependencies.memoryStore } : {}),
          ...(dependencies.moaPreset ? { moaPreset: dependencies.moaPreset } : {}),
        },
      );
    } finally {
      queues.clear();
      controller = undefined;
    }
  };

  return Object.freeze({
    run,
    abort: () => controller?.abort(new DOMException("Stopped by user", "AbortError")),
    steer: (text: string) => { requireRunning(); queues.enqueueSteer(normalizedText(text)); },
    followUp: (text: string) => { requireRunning(); queues.enqueueFollowUp(normalizedText(text)); },
    subscribe: (listener: AgentEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
    get isRunning() { return controller !== undefined; },
  });
};
