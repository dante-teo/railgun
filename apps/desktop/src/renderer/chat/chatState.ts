export type MessageStatus = "streaming" | "complete" | "queued" | "failed" | "stopped";
export type QueueKind = "steering" | "follow-up";

export interface TranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly status: Exclude<MessageStatus, "queued">;
}

export interface QueuedMessage {
  readonly id: string;
  readonly role: "user";
  readonly text: string;
  readonly status: "queued";
  readonly kind: QueueKind;
}

export interface RunRequest {
  readonly userId: string;
  readonly text: string;
}

export interface FailedRun extends RunRequest {
  readonly error: string;
}

export interface ChatState {
  readonly messages: readonly TranscriptMessage[];
  readonly queue: readonly QueuedMessage[];
  readonly running: boolean;
  readonly stopping: boolean;
  readonly submissionError: string | undefined;
  readonly failedRun: FailedRun | undefined;
  readonly activeRun: RunRequest | undefined;
}

export const initialChatState: ChatState = {
  messages: [],
  queue: [],
  running: false,
  stopping: false,
  submissionError: undefined,
  failedRun: undefined,
  activeRun: undefined,
};

export type ChatAction =
  | { readonly type: "initial-submit"; readonly id: string; readonly text: string }
  | { readonly type: "retry-start" }
  | { readonly type: "request-failed"; readonly userId: string; readonly text: string; readonly error: string }
  | { readonly type: "run-start" }
  | { readonly type: "assistant-delta"; readonly id: string; readonly text: string }
  | { readonly type: "assistant-complete" }
  | { readonly type: "queue-accepted"; readonly id: string; readonly kind: QueueKind; readonly text: string }
  | { readonly type: "queue-update"; readonly steering: readonly string[]; readonly followUp: readonly string[] }
  | { readonly type: "queue-rejected"; readonly error: string }
  | { readonly type: "stop-request" }
  | { readonly type: "stop-failed"; readonly error: string }
  | { readonly type: "stop-acknowledged" }
  | { readonly type: "run-end" }
  | { readonly type: "backend-failed"; readonly error: string }
  | { readonly type: "reset" };

const finishLastAssistant = (
  messages: readonly TranscriptMessage[],
  status: "complete" | "stopped",
): readonly TranscriptMessage[] => {
  let index = -1;
  for (let candidate = messages.length - 1; candidate >= 0; candidate -= 1) {
    const message = messages[candidate];
    if (message?.role === "assistant" && message.status === "streaming") {
      index = candidate;
      break;
    }
  }
  if (index < 0) return messages;
  return messages.map((message, messageIndex) => messageIndex === index ? { ...message, status } : message);
};

interface QueueReconciliation {
  readonly remaining: readonly QueuedMessage[];
  readonly injected: readonly QueuedMessage[];
}

/** Reconciles FIFO queues by suffix, preserving identity when queued text is duplicated. */
export const reconcileQueue = (
  current: readonly QueuedMessage[],
  backendTexts: readonly string[],
): QueueReconciliation => {
  let removed = 0;
  for (; removed <= current.length; removed += 1) {
    const remaining = current.slice(removed);
    if (remaining.length > backendTexts.length || (remaining.length === 0 && backendTexts.length !== 0)) continue;
    if (remaining.every((item, index) => item.text === backendTexts[index])) {
      return { remaining, injected: current.slice(0, removed) };
    }
  }
  return { remaining: current, injected: [] };
};

const reconcileQueues = (
  queue: readonly QueuedMessage[],
  steering: readonly string[],
  followUp: readonly string[],
): { readonly queue: readonly QueuedMessage[]; readonly injected: readonly QueuedMessage[] } => {
  const steeringResult = reconcileQueue(queue.filter(item => item.kind === "steering"), steering);
  const followUpResult = reconcileQueue(queue.filter(item => item.kind === "follow-up"), followUp);
  const remainingIds = new Set([...steeringResult.remaining, ...followUpResult.remaining].map(item => item.id));
  const injectedIds = new Set([...steeringResult.injected, ...followUpResult.injected].map(item => item.id));
  return {
    queue: queue.filter(item => remainingIds.has(item.id)),
    injected: queue.filter(item => injectedIds.has(item.id)),
  };
};

const failRun = (state: ChatState, userId: string, text: string, error: string): ChatState => {
  const userIndex = state.messages.findIndex(message => message.id === userId);
  // An earlier async request may settle after a new-chat reset.
  if (userIndex < 0) return state;
  let assistantIndex = -1;
  for (let candidate = state.messages.length - 1; candidate > userIndex; candidate -= 1) {
    if (state.messages[candidate]?.role === "assistant") {
      assistantIndex = candidate;
      break;
    }
  }
  const messages = state.messages.map((message, index) => {
    if (index === assistantIndex) return { ...message, status: "failed" as const };
    if (assistantIndex < 0 && message.id === userId) return { ...message, status: "failed" as const };
    return message;
  });
  return {
    ...state,
    messages,
    queue: [],
    running: false,
    stopping: false,
    failedRun: { userId, text, error },
    activeRun: undefined,
  };
};

export const chatReducer = (state: ChatState, action: ChatAction): ChatState => {
  switch (action.type) {
    case "initial-submit":
      return {
        ...state,
        messages: [...state.messages, { id: action.id, role: "user", text: action.text, status: "complete" }],
        queue: [],
        running: true,
        stopping: false,
        submissionError: undefined,
        failedRun: undefined,
        activeRun: { userId: action.id, text: action.text },
      };
    case "retry-start":
      if (state.failedRun === undefined) return state;
      const retry = state.failedRun;
      return {
        ...state,
        messages: state.messages.map(message => message.id === retry.userId
          ? { ...message, status: "complete" }
          : message),
        running: true,
        stopping: false,
        submissionError: undefined,
        failedRun: undefined,
        activeRun: { userId: retry.userId, text: retry.text },
      };
    case "request-failed":
      return failRun(state, action.userId, action.text, action.error);
    case "run-start":
      return { ...state, running: true };
    case "assistant-delta": {
      const last = state.messages.at(-1);
      const messages = last?.role === "assistant" && last.status === "streaming"
        ? [...state.messages.slice(0, -1), { ...last, text: last.text + action.text }]
        : [...state.messages, { id: action.id, role: "assistant" as const, text: action.text, status: "streaming" as const }];
      return { ...state, messages };
    }
    case "assistant-complete":
      return { ...state, messages: finishLastAssistant(state.messages, "complete") };
    case "queue-accepted":
      if (!state.running || state.stopping) return state;
      return {
        ...state,
        queue: [...state.queue, { id: action.id, role: "user", text: action.text, status: "queued", kind: action.kind }],
        submissionError: undefined,
      };
    case "queue-update": {
      const result = reconcileQueues(state.queue, action.steering, action.followUp);
      return {
        ...state,
        queue: result.queue,
        messages: [
          ...state.messages,
          ...result.injected.map(item => ({ id: `injected-${item.id}`, role: "user" as const, text: item.text, status: "complete" as const })),
        ],
      };
    }
    case "queue-rejected":
      return { ...state, submissionError: action.error };
    case "stop-request":
      return state.running && !state.stopping ? { ...state, stopping: true, submissionError: undefined } : state;
    case "stop-failed":
      return state.running ? { ...state, stopping: false, submissionError: action.error } : state;
    case "stop-acknowledged":
      return {
        ...state,
        queue: [],
      };
    case "run-end":
      return {
        ...state,
        messages: finishLastAssistant(state.messages, state.stopping ? "stopped" : "complete"),
        queue: [],
        running: false,
        stopping: false,
        activeRun: undefined,
      };
    case "backend-failed": {
      if (!state.running || state.activeRun === undefined) return state;
      return failRun(state, state.activeRun.userId, state.activeRun.text, action.error);
    }
    case "reset":
      return initialChatState;
  }
};
