import { z } from "zod";

export const MockScenarioIdSchema = z.enum([
  "ready-idle",
  "authentication-required",
  "delayed-startup",
  "command-rejection",
  "malformed-output",
  "crash-before-ready",
  "disconnect-after-ready",
  "handshake-failure",
  "empty-stores",
  "store-error",
  "approval",
  "clarification",
  "cancellation",
]);

export const TransportLogEntrySchema = z.strictObject({
  direction: z.enum(["system", "stdin", "stdout", "stderr"]),
  text: z.string(),
});

export const BackendSnapshotSchema = z.strictObject({
  mode: z.enum(["real", "mock"]),
  phase: z.enum(["starting", "ready", "authentication-required", "failed", "disconnected"]),
  scenarioId: MockScenarioIdSchema.optional(),
  error: z.string().optional(),
  diagnostics: z.array(z.string()).readonly(),
  transportLog: z.array(TransportLogEntrySchema).readonly(),
});

export const MockScenarioSchema = z.strictObject({
  id: MockScenarioIdSchema,
  label: z.string().min(1),
  description: z.string().min(1),
});

export const MockScenarioListSchema = z.array(MockScenarioSchema).readonly();

export const PromptTextSchema = z.string().trim().min(1).max(100_000);
export const EmptyResponseSchema = z.undefined();

export const DesktopAgentEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("run-start") }),
  z.strictObject({ type: z.literal("run-end") }),
  z.strictObject({ type: z.literal("assistant-delta"), text: z.string() }),
  z.strictObject({ type: z.literal("tool-start"), id: z.string(), name: z.string() }),
  z.strictObject({ type: z.literal("tool-end"), id: z.string(), name: z.string(), failed: z.boolean() }),
]);
