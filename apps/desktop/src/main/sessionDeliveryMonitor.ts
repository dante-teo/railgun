import type { BackendSnapshot, SessionSummary } from "../shared/types";

export interface SessionDeliveryMonitor {
  start(): void;
  stop(): void;
  poll(): Promise<void>;
}

interface SessionDeliveryMonitorOptions {
  readonly getSnapshot: () => Pick<BackendSnapshot, "phase">;
  readonly subscribe: (listener: (snapshot: BackendSnapshot) => void) => () => void;
  readonly getCursor: () => Promise<number>;
  readonly listSessions: () => Promise<readonly SessionSummary[]>;
  readonly emit: (sessions: readonly SessionSummary[]) => void;
  readonly intervalMs?: number;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

export const createSessionDeliveryMonitor = (
  options: SessionDeliveryMonitorOptions,
): SessionDeliveryMonitor => {
  const intervalMs = options.intervalMs ?? 2_000;
  const schedule = options.setInterval ?? globalThis.setInterval;
  const cancel = options.clearInterval ?? globalThis.clearInterval;
  let cursor = 0;
  let phase = options.getSnapshot().phase;
  let polling = false;
  let started = false;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const poll = async (): Promise<void> => {
    if (!started || phase !== "ready" || polling) return;
    polling = true;
    try {
      const nextCursor = await options.getCursor();
      if (nextCursor < cursor) {
        cursor = nextCursor;
        return;
      }
      if (nextCursor === cursor) return;
      const sessions = await options.listSessions();
      options.emit(sessions);
      cursor = nextCursor;
    } catch {
      // A later tick retries. Backend lifecycle errors are already surfaced by its snapshot.
    } finally {
      polling = false;
    }
  };

  const clearTimer = (): void => {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  };

  const syncTimer = (): void => {
    clearTimer();
    if (!started || phase !== "ready") return;
    timer = schedule(() => { void poll(); }, intervalMs);
    void poll();
  };

  return {
    start: () => {
      if (started) return;
      started = true;
      unsubscribe = options.subscribe(snapshot => {
        if (phase === snapshot.phase) return;
        phase = snapshot.phase;
        syncTimer();
      });
      phase = options.getSnapshot().phase;
      syncTimer();
    },
    stop: () => {
      if (!started) return;
      started = false;
      clearTimer();
      unsubscribe?.();
      unsubscribe = undefined;
    },
    poll,
  };
};
