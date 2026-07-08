import { DevinApiError, DevinAuthError } from "widevin";

export type RecoveryAction = "retry_with_backoff" | "fail_immediately" | "reauth_required";

const RETRYABLE_STATUSES: Record<number, true> = { 429: true, 502: true, 503: true };
const FATAL_STATUSES: Record<number, true> = { 400: true, 413: true };

export const classifyError = (err: unknown): RecoveryAction => {
  if (err instanceof DevinAuthError) return "reauth_required";
  if (err instanceof DevinApiError) {
    if (RETRYABLE_STATUSES[err.status]) return "retry_with_backoff";
    if (FATAL_STATUSES[err.status]) return "fail_immediately";
  }
  return "retry_with_backoff"; // unrecognized errors: assume transient, try a few times
};

const MAX_ATTEMPTS = 3;
const BACKOFF_MS_PER_ATTEMPT = 500;

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export const callDevinWithRecovery = async <T>(fn: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (classifyError(err) !== "retry_with_backoff" || attempt === MAX_ATTEMPTS) throw err;
      await delay(BACKOFF_MS_PER_ATTEMPT * attempt);
    }
  }
  throw new Error("unreachable"); // satisfies TS control-flow analysis; loop always returns or throws
};
