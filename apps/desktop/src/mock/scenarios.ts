import { MockScenarioIdSchema, MockScenarioSchema } from "../shared/schemas";
import type { MockScenario, MockScenarioId } from "../shared/types";

export type MockScenarioBehavior =
  | "ready"
  | "delayed-startup"
  | "reject-commands"
  | "malformed-output"
  | "crash-before-ready"
  | "disconnect-after-ready";

export interface MockScenarioDefinition extends Omit<MockScenario, "id"> {
  readonly id: string;
  readonly behavior: MockScenarioBehavior;
}

export const defineMockScenarios = (
  definitions: readonly MockScenarioDefinition[],
): ReadonlyMap<MockScenarioId, MockScenarioDefinition> => {
  const registry = new Map<MockScenarioId, MockScenarioDefinition>();
  for (const definition of definitions) {
    const id = MockScenarioIdSchema.parse(definition.id);
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
] as const);

export const listMockScenarios = (): readonly MockScenario[] =>
  [...MOCK_SCENARIOS.values()].map(({ id, label, description }) =>
    MockScenarioSchema.parse({ id, label, description }));

export const getMockScenario = (value: string): MockScenarioDefinition => {
  const parsedId = MockScenarioIdSchema.safeParse(value);
  if (!parsedId.success) throw new Error(`Unknown mock scenario: ${value}`);
  const id = parsedId.data;
  const scenario = MOCK_SCENARIOS.get(id);
  if (scenario === undefined) throw new Error(`Unknown mock scenario: ${id}`);
  return scenario;
};
