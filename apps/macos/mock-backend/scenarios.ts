export type MockScenarioBehavior =
  | "ready"
  | "authentication-required"
  | "delayed-startup"
  | "reject-commands"
  | "malformed-output"
  | "crash-before-ready"
  | "disconnect-after-ready"
  | "handshake-failure"
  | "empty-stores"
  | "store-error"
  | "approval"
  | "clarification"
  | "clarification-choice"
  | "clarification-free-text"
  | "cancellation"
  | "agent-activity"
  | "empty-model-catalog"
  | "slow-compaction";

export interface MockScenarioDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly behavior: MockScenarioBehavior;
}

const defineMockScenarios = (
  definitions: readonly MockScenarioDefinition[],
): ReadonlyMap<string, MockScenarioDefinition> => {
  const registry = new Map<string, MockScenarioDefinition>();
  for (const definition of definitions) {
    const id = definition.id.trim();
    if (id.length === 0) throw new Error("Mock scenario IDs must not be empty.");
    if (registry.has(id)) {
      throw new Error(`Duplicate mock scenario id: ${definition.id}`);
    }
    registry.set(id, Object.freeze({ ...definition, id }));
  }
  return registry;
};

export const MOCK_SCENARIOS = defineMockScenarios([
  {
    id: "ready-idle",
    label: "Ready / idle",
    description: "Starts immediately and reports an idle session.",
    behavior: "ready",
  },
  {
    id: "authentication-required",
    label: "Authentication required",
    description: "Requires terminal login before the backend can start.",
    behavior: "authentication-required",
  },
  {
    id: "delayed-startup",
    label: "Delayed startup",
    description: "Waits before answering the readiness probe.",
    behavior: "delayed-startup",
  },
  {
    id: "command-rejection",
    label: "Command rejection",
    description: "Rejects commands with a correlated RPC error.",
    behavior: "reject-commands",
  },
  {
    id: "malformed-output",
    label: "Malformed output",
    description: "Writes an invalid JSONL frame during startup.",
    behavior: "malformed-output",
  },
  {
    id: "crash-before-ready",
    label: "Crash before ready",
    description: "Exits before answering the readiness probe.",
    behavior: "crash-before-ready",
  },
  {
    id: "disconnect-after-ready",
    label: "Disconnect after ready",
    description: "Becomes ready and then exits unexpectedly.",
    behavior: "disconnect-after-ready",
  },
  {
    id: "handshake-failure",
    label: "Handshake failure",
    description: "Rejects the protocol v1 initialization handshake.",
    behavior: "handshake-failure",
  },
  {
    id: "empty-stores",
    label: "Empty stores",
    description: "Reports empty session, memory, cron, MCP, and skill stores.",
    behavior: "empty-stores",
  },
  {
    id: "store-error",
    label: "Store error",
    description: "Returns correlated errors for management commands.",
    behavior: "store-error",
  },
  {
    id: "approval",
    label: "Approval request",
    description: "Requests shell approval during a prompt.",
    behavior: "approval",
  },
  {
    id: "clarification",
    label: "Clarification request",
    description: "Requests clarification during a prompt.",
    behavior: "clarification",
  },
  {
    id: "clarification-choice",
    label: "Choice clarification",
    description: "Requests one answer from a bounded list of choices.",
    behavior: "clarification-choice",
  },
  {
    id: "clarification-free-text",
    label: "Free-text clarification",
    description: "Requests a validated free-text answer.",
    behavior: "clarification-free-text",
  },
  {
    id: "cancellation",
    label: "Cancellation",
    description: "Keeps a prompt active until it is aborted.",
    behavior: "cancellation",
  },
  {
    id: "agent-activity",
    label: "Agent activity",
    description: "Emits tools, todos, MoA, multiple subagents, and advisor notes.",
    behavior: "agent-activity",
  },
  {
    id: "empty-model-catalog",
    label: "Empty model catalog",
    description: "Returns no available models while retaining the active session model.",
    behavior: "empty-model-catalog",
  },
  {
    id: "slow-compaction",
    label: "Slow compaction",
    description: "Completes manual compaction after a deterministic delay.",
    behavior: "slow-compaction",
  },
] as const);

export const getMockScenario = (value: string): MockScenarioDefinition => {
  const scenario = MOCK_SCENARIOS.get(value);
  if (scenario === undefined) throw new Error(`Unknown mock scenario: ${value}`);
  return scenario;
};
