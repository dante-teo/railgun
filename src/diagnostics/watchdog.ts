export interface WatchedOperation {
  readonly operationId: string;
  readonly phase: string;
  readonly exempt?: boolean;
}

export interface WatchdogState {
  readonly lastHeartbeatAt: number;
  readonly lastProgressAt: number;
  readonly operation?: WatchedOperation;
  readonly eventLoopStalledAt?: number;
  readonly eventLoopLastWarningAt?: number;
  readonly operationStalledAt?: number;
  readonly operationLastWarningAt?: number;
  readonly pendingRecoveries: readonly WatchdogEvent[];
}

export interface WatchdogEvent {
  readonly event: "event_loop_stall" | "event_loop_recovery" | "operation_stall" | "operation_recovery";
  readonly durationMs: number;
  readonly operationId?: string;
  readonly phase?: string;
}

export const createWatchdogState = (now: number): WatchdogState => ({
  lastHeartbeatAt: now,
  lastProgressAt: now,
  pendingRecoveries: [],
});

export const noteHeartbeat = (state: WatchdogState, now: number): WatchdogState => {
  const recovery = state.eventLoopStalledAt === undefined ? [] : [{
    event: "event_loop_recovery" as const,
    durationMs: now - state.eventLoopStalledAt,
    ...(state.operation ? { operationId: state.operation.operationId, phase: state.operation.phase } : {}),
  }];
  const { eventLoopStalledAt: _stalledAt, eventLoopLastWarningAt: _lastWarningAt, ...healthy } = state;
  return {
    ...healthy,
    lastHeartbeatAt: now,
    pendingRecoveries: [...state.pendingRecoveries, ...recovery],
  };
};

export const noteProgress = (state: WatchdogState, now: number, operation?: WatchedOperation): WatchdogState => {
  const recovery = state.operationStalledAt === undefined ? [] : [{
    event: "operation_recovery" as const,
    durationMs: now - state.operationStalledAt,
    ...(state.operation ? { operationId: state.operation.operationId, phase: state.operation.phase } : {}),
  }];
  const { operationStalledAt: _stalledAt, operationLastWarningAt: _lastWarningAt, ...healthy } = state;
  return {
    ...healthy,
    lastProgressAt: now,
    ...(operation ? { operation } : {}),
    pendingRecoveries: [...state.pendingRecoveries, ...recovery],
  };
};

export const clearOperation = (state: WatchdogState, now: number): WatchdogState => {
  const progressed = noteProgress(state, now);
  const { operation: _operation, ...withoutOperation } = progressed;
  return withoutOperation;
};

const due = (lastWarningAt: number | undefined, now: number): boolean => lastWarningAt === undefined || now - lastWarningAt >= 30_000;

export const evaluateWatchdog = (state: WatchdogState, now: number): { readonly state: WatchdogState; readonly events: readonly WatchdogEvent[] } => {
  const events: WatchdogEvent[] = [...state.pendingRecoveries];
  let next: WatchdogState = { ...state, pendingRecoveries: [] };
  const heartbeatLate = now - state.lastHeartbeatAt >= 10_000;
  if (heartbeatLate && due(state.eventLoopLastWarningAt, now)) {
    const stalledAt = state.eventLoopStalledAt ?? now;
    events.push({ event: "event_loop_stall", durationMs: now - state.lastHeartbeatAt, ...(state.operation ? { operationId: state.operation.operationId, phase: state.operation.phase } : {}) });
    next = { ...next, eventLoopStalledAt: stalledAt, eventLoopLastWarningAt: now };
  }
  const operationLate = !heartbeatLate && state.operation !== undefined && !state.operation.exempt && now - state.lastProgressAt >= 30_000;
  if (operationLate && due(state.operationLastWarningAt, now)) {
    const stalledAt = state.operationStalledAt ?? now;
    events.push({ event: "operation_stall", durationMs: now - state.lastProgressAt, operationId: state.operation.operationId, phase: state.operation.phase });
    next = { ...next, operationStalledAt: stalledAt, operationLastWarningAt: now };
  }
  return { state: next, events };
};
