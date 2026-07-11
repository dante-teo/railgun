import type { Agent, AgentDependencies, AgentRunInput } from "./agent.js";
import { createAgent, normalizedText } from "./agent.js";
import type { AgentEvent } from "./events.js";
import type { TurnOutcome } from "./turn.js";

export type AgentSessionEvent =
  | AgentEvent
  | { type: "agent_settled" }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void | Promise<void>;

export interface AgentSession {
  readonly run: (input: string | AgentRunInput) => Promise<TurnOutcome>;
  readonly abort: () => void;
  readonly steer: (text: string) => void;
  readonly followUp: (text: string) => void;
  readonly subscribe: (listener: AgentSessionEventListener) => () => void;
  readonly isRunning: boolean;
}

export const createAgentSession = (dependencies: AgentDependencies): AgentSession => {
  const agent: Agent = createAgent(dependencies);
  const listeners = new Set<AgentSessionEventListener>();
  let steering: string[] = [];
  let followUp: string[] = [];

  const emit = async (event: AgentSessionEvent): Promise<void> => {
    for (const listener of listeners) {
      try {
        await listener(event);
      } catch (err) {
        console.error("Event listener failed:", err);
      }
    }
  };

  const emitQueueUpdate = (): Promise<void> =>
    emit({ type: "queue_update", steering: [...steering], followUp: [...followUp] });

  agent.subscribe(event => {
    if (event.type === "message_start" && event.message.role === "user" && typeof event.message.content === "string") {
      const text = event.message.content;
      const steerIndex = steering.indexOf(text);
      if (steerIndex !== -1) {
        steering = [...steering.slice(0, steerIndex), ...steering.slice(steerIndex + 1)];
        emitQueueUpdate();
      } else {
        const followUpIndex = followUp.indexOf(text);
        if (followUpIndex !== -1) {
          followUp = [...followUp.slice(0, followUpIndex), ...followUp.slice(followUpIndex + 1)];
          emitQueueUpdate();
        }
      }
    }
    return emit(event);
  });

  return Object.freeze({
    run: async (input: string | AgentRunInput) => {
      try {
        return await agent.run(input);
      } finally {
        emit({ type: "agent_settled" });
      }
    },
    abort: () => agent.abort(),
    steer: (text: string) => {
      agent.steer(text);
      steering = [...steering, normalizedText(text)];
      emitQueueUpdate();
    },
    followUp: (text: string) => {
      agent.followUp(text);
      followUp = [...followUp, normalizedText(text)];
      emitQueueUpdate();
    },
    subscribe: (listener: AgentSessionEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
    get isRunning() { return agent.isRunning; },
  });
};
