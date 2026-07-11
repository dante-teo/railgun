import { DevinApiError, DevinAuthError } from "widevin";
import { CredentialRejectedError } from "../auth.js";

export type RecoveryAction = "retry_with_backoff" | "fail_immediately" | "compress_and_retry" | "reauth_required";

const isFetchTransportFailure = (error: unknown): boolean =>
  error instanceof TypeError && /fetch|network|socket|connection/i.test(error.message);

export const classifyError = (err: unknown): RecoveryAction => {
  if (err instanceof CredentialRejectedError || err instanceof DevinAuthError) return "reauth_required";
  if (err instanceof DevinApiError) {
    if (err.status === 401) return "reauth_required";
    if (err.status === 408 || err.status === 429 || (err.status >= 500 && err.status <= 599)) {
      return "retry_with_backoff";
    }
    if (err.status === 413) return "compress_and_retry";
    return "fail_immediately";
  }
  return isFetchTransportFailure(err) ? "retry_with_backoff" : "fail_immediately";
};

const MAX_ATTEMPTS = 3;
const MAX_COMPRESS_ATTEMPTS = 3;
const BACKOFF_MS_PER_ATTEMPT = 500;

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const callWithAttempt = async <T>(
  fn: () => Promise<T>,
  attempt: number,
  compress?: () => Promise<void>,
  compressAttempts = 0
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    const action = classifyError(error);
    if (action === "compress_and_retry" && compress) {
      if (compressAttempts === MAX_COMPRESS_ATTEMPTS) throw error;
      await compress();
      return callWithAttempt(fn, attempt, compress, compressAttempts + 1);
    }
    if (action !== "retry_with_backoff" || attempt === MAX_ATTEMPTS) throw error;
    await delay(BACKOFF_MS_PER_ATTEMPT * attempt);
    return callWithAttempt(fn, attempt + 1, compress, compressAttempts);
  }
};

export const callDevinWithRecovery = <T>(fn: () => Promise<T>, compress?: () => Promise<void>): Promise<T> =>
  callWithAttempt(fn, 1, compress);
