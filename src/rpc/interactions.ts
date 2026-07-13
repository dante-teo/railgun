import { randomUUID } from "node:crypto";
import type { RpcInteractionRequest } from "./types.js";

type Pending<T> = {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
};

export interface RpcInteractions {
  requestApproval(command: string): Promise<boolean>;
  requestClarification(question: string, choices?: readonly string[]): Promise<string>;
  resolveApproval(requestId: string, approved: boolean): void;
  resolveClarification(requestId: string, answer: string): void;
  rejectAll(reason: string): void;
}

export const createRpcInteractions = (
  emit: (request: RpcInteractionRequest) => void,
  options: { readonly randomId?: () => string; readonly timeoutMs?: number } = {},
): RpcInteractions => {
  const approvals = new Map<string, Pending<boolean>>();
  const clarifications = new Map<string, Pending<string>>();
  const randomId = options.randomId ?? randomUUID;

  const request = <T>(
    map: Map<string, Pending<T>>,
    event: (requestId: string) => RpcInteractionRequest,
  ): Promise<T> => {
    const requestId = randomId();
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      if (!map.delete(requestId)) return;
      reject(new Error("interaction request timed out"));
    }, options.timeoutMs);
    map.set(requestId, { resolve, reject, ...(timer === undefined ? {} : { timer }) });
    emit(event(requestId));
    return promise;
  };

  const resolve = <T>(map: Map<string, Pending<T>>, requestId: string, value: T, kind: string): void => {
    const pending = map.get(requestId);
    if (pending === undefined) throw new Error(`unknown or already resolved ${kind} request: ${requestId}`);
    map.delete(requestId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.resolve(value);
  };

  const rejectAll = (reason: string): void => {
    const error = new Error(reason);
    for (const map of [approvals, clarifications] as const) {
      for (const pending of map.values()) {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.reject(error);
      }
      map.clear();
    }
  };

  return {
    requestApproval: command => request(approvals, requestId => ({ type: "approval_request", requestId, command })),
    requestClarification: (question, choices) => request(clarifications, requestId => ({
      type: "clarification_request",
      requestId,
      question,
      ...(choices === undefined ? {} : { choices }),
    })),
    resolveApproval: (requestId, approved) => {
      if (clarifications.has(requestId)) throw new Error(`request ${requestId} is a clarification request`);
      resolve(approvals, requestId, approved, "approval");
    },
    resolveClarification: (requestId, answer) => {
      if (approvals.has(requestId)) throw new Error(`request ${requestId} is an approval request`);
      resolve(clarifications, requestId, answer, "clarification");
    },
    rejectAll,
  };
};
