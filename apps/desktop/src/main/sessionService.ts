import { z } from "zod";
import {
  DESKTOP_SESSION_LIMITS,
  SessionIdSchema,
  SessionSnapshotSchema,
  SessionSummaryListSchema,
  RestoredTranscriptMessageSchema,
  RestoredTodoSchema,
  PersistenceMessageIdSchema,
} from "../shared/schemas";
import type { SessionSnapshot, SessionSummary } from "../shared/types";
import type { BackendRpcCommand } from "./backendSupervisor";

type Call = <T>(command: BackendRpcCommand, validate: (data: unknown) => T) => Promise<T>;

const rawSummaryList = z.strictObject({ sessions: SessionSummaryListSchema });
const rawMutation = z.strictObject({
  sessionId: SessionIdSchema,
});
const rawBranchMutation = z.strictObject({
  recentMessages: z.array(z.strictObject({
    id: PersistenceMessageIdSchema,
    role: z.string().max(32),
    preview: z.string().max(DESKTOP_SESSION_LIMITS.preview),
  })).max(100),
});
const rawTranscriptPage = z.strictObject({
  sessionId: SessionIdSchema,
  messages: z.array(RestoredTranscriptMessageSchema).max(100),
  nextCursor: z.number().int().nonnegative().optional(),
});
const rawState = z.strictObject({
  running: z.boolean(),
  model: z.string().trim().min(1).max(DESKTOP_SESSION_LIMITS.model),
  messageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  todos: z.array(RestoredTodoSchema).max(DESKTOP_SESSION_LIMITS.todos),
  protocolVersion: z.literal(1),
  sessionId: SessionIdSchema,
  startedAt: z.string().datetime(),
  persistence: z.enum(["unsaved", "saved", "error"]),
  checkpointError: z.string().max(DESKTOP_SESSION_LIMITS.checkpointError).optional(),
});

export const createSessionService = (call: Call) => {
  const loadTranscript = async (sessionId: string): Promise<SessionSnapshot["transcript"]> => {
    const messages: SessionSnapshot["transcript"][number][] = [];
    let cursor = 0;
    while (messages.length < DESKTOP_SESSION_LIMITS.messages) {
      const page = await call(
        { type: "session_transcript", sessionId, cursor, limit: 100 },
        value => rawTranscriptPage.parse(value),
      );
      if (page.sessionId !== sessionId) throw new Error("Backend returned a mismatched transcript");
      messages.push(...page.messages);
      if (page.nextCursor === undefined) break;
      if (page.nextCursor <= cursor) throw new Error("Backend returned an invalid transcript cursor");
      cursor = page.nextCursor;
    }
    return messages.slice(0, DESKTOP_SESSION_LIMITS.messages);
  };
  const snapshot = async (): Promise<SessionSnapshot> => {
    const state = await call({ type: "get_state" }, value => rawState.parse(value));
    const transcript = await loadTranscript(state.sessionId);
    return SessionSnapshotSchema.parse({
      id: state.sessionId,
      startedAt: state.startedAt,
      model: state.model,
      messageCount: state.messageCount,
      running: state.running,
      checkpoint: state.running ? { state: "pending" }
        : state.persistence === "saved" ? { state: "saved" }
          : state.persistence === "error" ? { state: "error", detail: state.checkpointError ?? "Checkpoint failed" }
            : { state: "unsaved" },
      transcript,
      todos: state.todos,
    });
  };
  return {
    list: async (): Promise<readonly SessionSummary[]> => (await call({ type: "session_list" }, value => rawSummaryList.parse(value))).sessions,
    create: async (): Promise<SessionSnapshot> => {
      const result = await call({ type: "session_new" }, value => rawMutation.parse(value));
      const next = await snapshot();
      if (next.id !== result.sessionId) throw new Error("Backend activated a mismatched session");
      return next;
    },
    resume: async (sessionId: string): Promise<SessionSnapshot> => {
      const validId = SessionIdSchema.parse(sessionId);
      const result = await call({ type: "session_load", sessionId: validId, includeMessages: false }, value => rawMutation.parse(value));
      if (result.sessionId !== validId) throw new Error("Backend activated a mismatched session");
      const next = await snapshot();
      if (next.id !== validId) throw new Error("Backend reported a mismatched active session");
      return next;
    },
    branch: async (messageId: number, summarize: boolean): Promise<SessionSnapshot> => {
      const validMessageId = PersistenceMessageIdSchema.parse(messageId);
      if (typeof summarize !== "boolean") throw new Error("Summarize must be a boolean");
      await call(
        { type: "session_branch", messageId: validMessageId, summarize, includeMessages: false },
        value => rawBranchMutation.parse(value),
      );
      return snapshot();
    },
    fork: async (sessionId: string): Promise<SessionSnapshot> => {
      const validId = SessionIdSchema.parse(sessionId);
      const result = await call(
        { type: "session_fork", sessionId: validId, includeMessages: false },
        value => rawMutation.parse(value),
      );
      const next = await snapshot();
      if (next.id !== result.sessionId) throw new Error("Backend activated a mismatched fork");
      return next;
    },
    snapshot,
  };
};
