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

export const DESKTOP_INTERACTION_LIMITS = Object.freeze({
  backendRequestId: 256,
  correlationId: 128,
  command: 8_000,
  question: 8_000,
  choice: 500,
  choices: 32,
  answer: 100_000,
});

export const DESKTOP_CONTROL_LIMITS = Object.freeze({
  models: 256,
  presets: 128,
  modelId: 256,
  modelName: 500,
  presetName: 256,
  referenceModels: 8,
  warning: 2_000,
});

export const DESKTOP_SESSION_LIMITS = Object.freeze({
  sessions: 500,
  messages: 2_000,
  todos: 256,
  id: 256,
  model: 256,
  preview: 500,
  messageText: 100_000,
  todoText: 2_000,
  checkpointError: 2_000,
});

export const DESKTOP_FILE_LIMITS = Object.freeze({
  pathDepth: 128,
  segment: 255,
  directoryEntries: 5_000,
  textBytes: 1_048_576,
  imageBytes: 10_485_760,
  imagePixels: 40_000_000,
  dataUrl: 60_000_000,
});

export const FileNameSchema = z.string()
  .min(1)
  .max(DESKTOP_FILE_LIMITS.segment)
  .refine(value => !value.includes("/") && !value.includes("\0"), "Expected one filesystem name");
export const FilePathSegmentSchema = FileNameSchema
  .refine(value => value !== "." && value !== "..", "Relative path markers are not allowed")
  .refine(value => !value.includes("/"), "Expected one relative path segment");
export const FilePathSegmentsSchema = z.array(FilePathSegmentSchema)
  .max(DESKTOP_FILE_LIMITS.pathDepth)
  .readonly();
export const DirectoryEntrySchema = z.strictObject({
  name: FileNameSchema,
  kind: z.enum(["directory", "file", "unavailable"]),
  symlink: z.boolean(),
});
export const DirectoryListingSchema = z.strictObject({
  entries: z.array(DirectoryEntrySchema).max(DESKTOP_FILE_LIMITS.directoryEntries).readonly(),
});
export const FilePreviewSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    text: z.string().max(DESKTOP_FILE_LIMITS.textBytes),
  }),
  z.strictObject({
    kind: z.literal("image"),
    dataUrl: z.string().max(DESKTOP_FILE_LIMITS.dataUrl).startsWith("data:image/png;base64,"),
    width: z.number().int().positive().max(DESKTOP_FILE_LIMITS.imagePixels),
    height: z.number().int().positive().max(DESKTOP_FILE_LIMITS.imagePixels),
  }).refine(value => value.width * value.height <= DESKTOP_FILE_LIMITS.imagePixels, "Image dimensions are too large"),
]);

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
  "clarification-choice",
  "clarification-free-text",
  "cancellation",
  "agent-activity",
  "empty-model-catalog",
  "slow-compaction",
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

export const SessionIdSchema = z.string().trim().min(1).max(DESKTOP_SESSION_LIMITS.id);
export const PersistenceMessageIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sessionModel = z.string().trim().min(1).max(DESKTOP_SESSION_LIMITS.model);
export const SessionSummarySchema = z.strictObject({
  id: SessionIdSchema,
  model: sessionModel,
  startedAtLocal: z.string().trim().min(1).max(500),
  messageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  firstUserPreview: z.string().max(DESKTOP_SESSION_LIMITS.preview),
});
export const SessionSummaryListSchema = z.array(SessionSummarySchema).max(DESKTOP_SESSION_LIMITS.sessions).readonly();

export const RestoredTranscriptMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(DESKTOP_SESSION_LIMITS.messageText),
  messageId: PersistenceMessageIdSchema.optional(),
  branchable: z.literal(true).optional(),
}).superRefine((message, context) => {
  if (message.branchable && (message.role !== "assistant" || message.messageId === undefined)) {
    context.addIssue({ code: "custom", message: "Branchable messages must be persisted assistant boundaries" });
  }
});
export const RestoredTodoSchema = z.strictObject({
  id: z.string().min(1).max(DESKTOP_SESSION_LIMITS.id),
  content: z.string().min(1).max(DESKTOP_SESSION_LIMITS.todoText),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
});
export const CheckpointStatusSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("pending") }),
  z.strictObject({ state: z.literal("saved") }),
  z.strictObject({ state: z.literal("unsaved") }),
  z.strictObject({ state: z.literal("error"), detail: z.string().trim().min(1).max(DESKTOP_SESSION_LIMITS.checkpointError) }),
]);
export const SessionSnapshotSchema = z.strictObject({
  id: SessionIdSchema,
  startedAt: z.string().datetime(),
  model: sessionModel,
  messageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  running: z.boolean(),
  checkpoint: CheckpointStatusSchema,
  transcript: z.array(RestoredTranscriptMessageSchema).max(DESKTOP_SESSION_LIMITS.messages).readonly(),
  todos: z.array(RestoredTodoSchema).max(DESKTOP_SESSION_LIMITS.todos).readonly(),
});

export const ChatModelIdSchema = z.string().trim().min(1).max(DESKTOP_CONTROL_LIMITS.modelId);
const controlPresetName = z.string().trim().min(1).max(DESKTOP_CONTROL_LIMITS.presetName);
const tokenLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const DesktopModelMetadataSchema = z.strictObject({
  id: ChatModelIdSchema,
  name: z.string().trim().min(1).max(DESKTOP_CONTROL_LIMITS.modelName),
  inputs: z.array(z.enum(["text", "image"])).min(1).max(2).readonly(),
  supportsTools: z.boolean(),
  reasoning: z.boolean(),
  contextWindow: tokenLimit,
  maxOutputTokens: tokenLimit,
});

export const MoAPresetSummarySchema = z.strictObject({
  name: controlPresetName,
  referenceModels: z.array(ChatModelIdSchema).min(1).max(DESKTOP_CONTROL_LIMITS.referenceModels).readonly(),
  aggregatorModel: ChatModelIdSchema,
  referenceMaxTokens: tokenLimit.optional(),
});

export const AdvisorControlSchema = z.strictObject({
  enabled: z.boolean(),
  modelId: ChatModelIdSchema.nullable(),
}).superRefine((value, context) => {
  if (value.enabled && value.modelId === null) context.addIssue({ code: "custom", message: "Enabled advisor requires a model" });
});

export const ChatControlsSnapshotSchema = z.strictObject({
  models: z.array(DesktopModelMetadataSchema).max(DESKTOP_CONTROL_LIMITS.models).readonly(),
  activeModelId: ChatModelIdSchema,
  defaultModelId: ChatModelIdSchema.nullable(),
  messageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  moaPresets: z.array(MoAPresetSummarySchema).max(DESKTOP_CONTROL_LIMITS.presets).readonly(),
  activeMoaPreset: controlPresetName.nullable(),
  advisor: AdvisorControlSchema,
  contextWindow: tokenLimit.nullable(),
});

export const ModelPersistenceModeSchema = z.enum(["chat", "default"]);

export const AgentControlUpdateSchema = z.strictObject({
  moaPreset: controlPresetName.nullable().optional(),
  advisor: AdvisorControlSchema.optional(),
}).superRefine((value, context) => {
  if (value.moaPreset === undefined && value.advisor === undefined) {
    context.addIssue({ code: "custom", message: "At least one agent control must be provided" });
  }
});

export const ControlMutationResultSchema = z.strictObject({
  controls: ChatControlsSnapshotSchema,
  persistence: z.enum(["session-only", "saved", "partial"]),
  warning: z.string().trim().min(1).max(DESKTOP_CONTROL_LIMITS.warning).optional(),
});

export const InteractionCorrelationIdSchema = z.string().trim().min(1).max(DESKTOP_INTERACTION_LIMITS.correlationId);
export const BackendInteractionRequestIdSchema = z.string().min(1).max(DESKTOP_INTERACTION_LIMITS.backendRequestId);
const interactionCommand = z.string().trim().min(1).max(DESKTOP_INTERACTION_LIMITS.command);
const interactionQuestion = z.string().trim().min(1).max(DESKTOP_INTERACTION_LIMITS.question);
const interactionChoice = z.string().trim().min(1).max(DESKTOP_INTERACTION_LIMITS.choice);

export const BackendApprovalRequestSchema = z.strictObject({
  type: z.literal("approval_request"),
  requestId: BackendInteractionRequestIdSchema,
  command: interactionCommand,
});

export const BackendClarificationRequestSchema = z.strictObject({
  type: z.literal("clarification_request"),
  requestId: BackendInteractionRequestIdSchema,
  question: interactionQuestion,
  choices: z.array(interactionChoice).min(1).max(DESKTOP_INTERACTION_LIMITS.choices).optional(),
});

export const DesktopInteractionRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("approval"),
    id: InteractionCorrelationIdSchema,
    command: interactionCommand,
  }),
  z.strictObject({
    type: z.literal("clarification"),
    id: InteractionCorrelationIdSchema,
    question: interactionQuestion,
    choices: z.array(interactionChoice).min(1).max(DESKTOP_INTERACTION_LIMITS.choices).optional(),
  }),
]);

export const ClarificationAnswerSchema = z.string().trim().min(1).max(DESKTOP_INTERACTION_LIMITS.answer);

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
  z.strictObject({
    type: z.literal("context-usage"),
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({ type: z.literal("context-reset"), reason: z.enum(["compaction", "model", "backend", "new-chat"]) }),
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
