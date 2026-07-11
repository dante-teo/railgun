import type { DevinMessage, DevinProvider } from "widevin";
import type { TodoStore } from "../tools/todo.js";
import { IterationBudget } from "./iterationBudget.js";
import type { LoopCallbacks, TurnOutcome } from "./turn.js";
import { runTurn } from "./turn.js";
import { createMessageQueues } from "./queue.js";

export interface AgentDependencies {
  readonly devin: DevinProvider;
  readonly model: string;
  readonly contextWindow: number;
  readonly systemPrompt: readonly string[];
  readonly confirmShellCommand: (command: string) => Promise<boolean>;
  readonly callbacks?: LoopCallbacks;
  readonly todoStore?: TodoStore;
  readonly iterationBudget?: () => IterationBudget;
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
  readonly isRunning: boolean;
}

const normalizedText = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Queued messages must not be empty");
  return trimmed;
};

export const createAgent = (dependencies: AgentDependencies): Agent => {
  const queues = createMessageQueues();
  let controller: AbortController | undefined;

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
        dependencies.callbacks,
        {
          signal: currentController.signal,
          takeSteer: queues.takeSteer,
          takeFollowUps: queues.takeFollowUps,
          clearQueues: queues.clear,
          ...(dependencies.todoStore ? { todoStore: dependencies.todoStore } : {}),
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
    get isRunning() { return controller !== undefined; },
  });
};
