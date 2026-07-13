export const DEFAULT_OPERATION_TIMEOUT_MS = 600_000;

export class OperationTimeoutError extends Error {
  readonly name = "OperationTimeoutError";

  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
  }
}

/** Races cooperative or non-cooperative async work against cancellation and a deadline. */
export const runBoundedOperation = <T>(
  parentSignal: AbortSignal,
  timeoutMs: number | undefined,
  operation: string,
  run: (signal: AbortSignal) => Promise<T>,
  options: { readonly flushAlreadyProduced?: boolean } = {},
): Promise<T> => {
  const scopedController = new AbortController();
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = (complete: () => void): void => {
    if (settled) return;
    settled = true;
    parentSignal.removeEventListener("abort", onAbort);
    if (timer !== undefined) clearTimeout(timer);
    complete();
  };
  const onAbort = (): void => {
    scopedController.abort(parentSignal.reason);
    // Give cooperative work one microtask to flush any already-produced value
    // before detaching it. Non-cooperative work still settles without waiting.
    queueMicrotask(() => settle(() => reject(parentSignal.reason ?? new DOMException("Aborted", "AbortError"))));
  };
  if (parentSignal.aborted && !options.flushAlreadyProduced) {
    return Promise.reject(parentSignal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  parentSignal.addEventListener("abort", onAbort, { once: true });
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      const error = new OperationTimeoutError(operation, timeoutMs);
      scopedController.abort(error);
      settle(() => reject(error));
    }, timeoutMs);
    timer.unref?.();
  }

  let operationPromise: Promise<T>;
  try {
    operationPromise = run(scopedController.signal);
  } catch (error) {
    settle(() => reject(error));
    return promise;
  }
  if (parentSignal.aborted) onAbort();
  operationPromise.then(
    value => settle(() => resolve(value)),
    error => settle(() => reject(error)),
  );
  return promise;
};
