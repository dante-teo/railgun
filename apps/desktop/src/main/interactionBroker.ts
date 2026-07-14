import { randomUUID } from "node:crypto";
import {
  BackendApprovalRequestSchema,
  BackendClarificationRequestSchema,
  BackendInteractionRequestIdSchema,
  ClarificationAnswerSchema,
  DESKTOP_INTERACTION_LIMITS,
  DesktopInteractionRequestSchema,
  InteractionCorrelationIdSchema,
} from "../shared/schemas";
import type { DesktopInteractionRequest } from "../shared/types";
import { redactSensitiveText } from "./backendSupervisor";

const TOKEN_TEXT = /\b(?:Bearer\s+)?(?:sk|gh[opusr]|xox[baprs])[-_][A-Za-z0-9._-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const DECLINED_ANSWER = "[user declined to answer]";

const redactInteractionText = (value: string): string =>
  redactSensitiveText(value).replace(TOKEN_TEXT, "[REDACTED]");

const bound = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;

const redactAndBound = (value: string, limit: number): string =>
  bound(redactInteractionText(value), limit);

type InteractionKind = "approval" | "clarification";

interface PendingInteraction {
  readonly kind: InteractionKind;
  readonly backendRequestId: string;
}

export interface InteractionBroker {
  receiveBackendEvent: (value: unknown) => DesktopInteractionRequest | undefined;
  respondToApproval: (id: string, approved: boolean) => Promise<void>;
  respondToClarification: (id: string, answer: string) => Promise<void>;
  settle: () => void;
  pendingCount: () => number;
}

interface InteractionBrokerOptions {
  readonly call: (command: Readonly<{ type: string; [key: string]: unknown }>, validate: (data: unknown) => void) => Promise<void>;
  readonly emit: (request: DesktopInteractionRequest) => void;
  readonly randomId?: () => string;
}

const validateEmptyResponse = (data: unknown): void => {
  if (data !== undefined) throw new Error("Backend interaction response contained unexpected data");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createInteractionBroker = ({ call, emit, randomId = randomUUID }: InteractionBrokerOptions): InteractionBroker => {
  const byDesktopId = new Map<string, PendingInteraction>();
  const byBackendId = new Map<string, string>();

  const nextDesktopId = (backendRequestId: string): string => {
    const pick = (attempt: number): string | undefined => {
      const candidate = randomId();
      const parsed = InteractionCorrelationIdSchema.safeParse(candidate);
      if (parsed.success && candidate !== backendRequestId && !byDesktopId.has(candidate)) return parsed.data;
      return attempt < 100 ? pick(attempt + 1) : undefined;
    };
    const candidate = pick(0);
    if (candidate !== undefined) return candidate;
    let fallback = randomUUID();
    while (fallback === backendRequestId || byDesktopId.has(fallback)) fallback = randomUUID();
    return InteractionCorrelationIdSchema.parse(fallback);
  };

  const settleInvalidInteraction = (value: unknown): void => {
    if (!isRecord(value)) return;
    const requestId = BackendInteractionRequestIdSchema.safeParse(value.requestId);
    const type = value.type;
    const command = requestId.success && type === "approval_request"
      ? { type: "approval_response", requestId: requestId.data, approved: false }
      : requestId.success && type === "clarification_request"
        ? { type: "clarification_response", requestId: requestId.data, answer: DECLINED_ANSWER }
        : { type: "abort" };
    const fallback = (): void => {
      try { void call({ type: "abort" }, validateEmptyResponse).catch(() => undefined); }
      catch { /* The backend is already unavailable. */ }
    };
    try { void call(command, validateEmptyResponse).catch(fallback); }
    catch { fallback(); }
  };

  const receiveBackendEvent = (value: unknown): DesktopInteractionRequest | undefined => {
    const approval = BackendApprovalRequestSchema.safeParse(value);
    const clarification = BackendClarificationRequestSchema.safeParse(value);
    if (!approval.success && !clarification.success) {
      if (typeof value === "object" && value !== null && (value as Record<string, unknown>).type === "agent_end") {
        byDesktopId.clear();
        byBackendId.clear();
      } else if (isRecord(value) && (value.type === "approval_request" || value.type === "clarification_request")) {
        settleInvalidInteraction(value);
      }
      return undefined;
    }

    const requestId = approval.success ? approval.data.requestId : clarification.success ? clarification.data.requestId : undefined;
    if (requestId === undefined || byBackendId.has(requestId)) return undefined;
    const id = nextDesktopId(requestId);
    let request: DesktopInteractionRequest;
    if (approval.success) {
      const result = DesktopInteractionRequestSchema.safeParse({
        type: "approval",
        id,
        command: redactAndBound(approval.data.command, DESKTOP_INTERACTION_LIMITS.command),
      });
      if (!result.success) {
        settleInvalidInteraction(value);
        return undefined;
      }
      request = result.data;
    } else if (clarification.success) {
      const result = DesktopInteractionRequestSchema.safeParse({
        type: "clarification",
        id,
        question: redactAndBound(clarification.data.question, DESKTOP_INTERACTION_LIMITS.question),
        ...(clarification.data.choices === undefined ? {} : {
          choices: clarification.data.choices.map(choice => redactAndBound(choice, DESKTOP_INTERACTION_LIMITS.choice)),
        }),
      });
      if (!result.success) {
        settleInvalidInteraction(value);
        return undefined;
      }
      request = result.data;
    } else return undefined;
    byDesktopId.set(id, { kind: request.type, backendRequestId: requestId });
    byBackendId.set(requestId, id);
    emit(request);
    return request;
  };

  const respond = async (
    id: string,
    kind: InteractionKind,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    const pending = byDesktopId.get(id);
    if (pending === undefined) throw new Error("Unknown or already settled interaction request");
    if (pending.kind !== kind) throw new Error(`Interaction request is not an ${kind} request`);
    await call({ type: `${kind}_response`, requestId: pending.backendRequestId, ...payload }, validateEmptyResponse);
    byDesktopId.delete(id);
    byBackendId.delete(pending.backendRequestId);
  };

  return {
    receiveBackendEvent,
    respondToApproval: (id, approved) => {
      const validId = InteractionCorrelationIdSchema.parse(id);
      if (typeof approved !== "boolean") throw new Error("Approval response must be a boolean");
      return respond(validId, "approval", { approved });
    },
    respondToClarification: (id, answer) => {
      const validId = InteractionCorrelationIdSchema.parse(id);
      const validAnswer = ClarificationAnswerSchema.parse(answer);
      return respond(validId, "clarification", { answer: validAnswer });
    },
    settle: () => {
      byDesktopId.clear();
      byBackendId.clear();
    },
    pendingCount: () => byDesktopId.size,
  };
};
