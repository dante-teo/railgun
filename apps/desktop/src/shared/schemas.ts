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
  z.strictObject({ type: z.literal("tool-start"), id: z.string(), name: z.string() }),
  z.strictObject({ type: z.literal("tool-end"), id: z.string(), name: z.string(), failed: z.boolean() }),
]);
