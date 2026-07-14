import { z } from "zod";

export const DESKTOP_ACTIVITY_LIMITS = Object.freeze({
  id: 256,
  toolName: 128,
  detail: 8_000,
  content: 2_000,
  model: 256,
  preview: 500,
  todos: 256,
});

const boundedActivityString = (limit: number) => z.string().max(limit);
const activityId = boundedActivityString(DESKTOP_ACTIVITY_LIMITS.id).min(1);
const modelName = boundedActivityString(DESKTOP_ACTIVITY_LIMITS.model).min(1);

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
  "agent-activity",
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
export const ExternalUrlSchema = z.string().max(2_048).transform((value, context) => {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" || url.password !== "") {
      throw new Error("unsupported URL");
    }
    return url.href;
  } catch {
    context.addIssue({ code: "custom", message: "Expected an absolute HTTP(S) URL" });
    return z.NEVER;
  }
});
export const EmptyResponseSchema = z.undefined();

export const AppCommandSchema = z.enum([
  "new-chat",
  "command-palette",
  "show-chat",
  "show-settings",
  "toggle-sidebar",
  "retry-backend",
  "stop-response",
]);

export const DesktopAgentEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("run-start") }),
  z.strictObject({ type: z.literal("run-end") }),
  z.strictObject({ type: z.literal("assistant-delta"), text: z.string() }),
  z.strictObject({ type: z.literal("assistant-complete") }),
  z.strictObject({
    type: z.literal("queue-update"),
    steering: z.array(z.string()).readonly(),
    followUp: z.array(z.string()).readonly(),
  }),
  z.strictObject({
    type: z.literal("tool-start"),
    id: activityId,
    name: boundedActivityString(DESKTOP_ACTIVITY_LIMITS.toolName).min(1),
    input: boundedActivityString(DESKTOP_ACTIVITY_LIMITS.detail).optional(),
  }),
  z.strictObject({
    type: z.literal("tool-end"),
    id: activityId,
    name: boundedActivityString(DESKTOP_ACTIVITY_LIMITS.toolName).min(1),
    failed: z.boolean(),
    output: boundedActivityString(DESKTOP_ACTIVITY_LIMITS.detail).optional(),
    todos: z.array(z.strictObject({
      id: activityId,
      content: boundedActivityString(DESKTOP_ACTIVITY_LIMITS.content).min(1),
      status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
    })).max(DESKTOP_ACTIVITY_LIMITS.todos).readonly().optional(),
  }),
  z.strictObject({ type: z.literal("moa-reference-start"), index: z.number().int().nonnegative(), count: z.number().int().positive(), model: modelName }),
  z.strictObject({ type: z.literal("moa-reference-end"), index: z.number().int().nonnegative(), model: modelName, preview: boundedActivityString(DESKTOP_ACTIVITY_LIMITS.preview) }),
  z.strictObject({ type: z.literal("moa-aggregating"), model: modelName, refCount: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal("advisor-note"), severity: z.enum(["nit", "concern", "blocker"]), text: boundedActivityString(DESKTOP_ACTIVITY_LIMITS.content).min(1) }),
  z.strictObject({ type: z.literal("subagent-start"), index: z.number().int().nonnegative(), count: z.number().int().positive(), goal: boundedActivityString(DESKTOP_ACTIVITY_LIMITS.content).min(1) }),
  z.strictObject({ type: z.literal("subagent-end"), index: z.number().int().nonnegative(), goal: boundedActivityString(DESKTOP_ACTIVITY_LIMITS.content).min(1), result: boundedActivityString(DESKTOP_ACTIVITY_LIMITS.content) }),
]);
