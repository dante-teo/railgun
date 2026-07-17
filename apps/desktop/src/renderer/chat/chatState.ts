import type { DesktopAgentEvent, DesktopInteractionRequest, RestoredTodo, RestoredTranscriptEntry } from "../../shared/types";
import { activityReducer, initialActivityState } from "./activityState";
import type { ActivityEntry, ActivityState } from "./activityState";

export type MessageStatus = "streaming" | "complete" | "queued" | "failed" | "stopped";
export type QueueKind = "steering" | "follow-up";

export interface ApprovalPrompt {
  readonly type: "approval";
  readonly id: string;
  readonly command: string;
  readonly submitting: boolean;
  readonly error: string | undefined;
}

export interface ClarificationPrompt {
  readonly type: "clarification";
  readonly id: string;
  readonly question: string;
  readonly choices: readonly string[] | undefined;
  readonly answer: string;
  readonly submitting: boolean;
  readonly error: string | undefined;
}

export type InteractionPrompt = ApprovalPrompt | ClarificationPrompt;

export interface TranscriptMessage {
  readonly id: string;
  readonly messageId?: number;
  readonly branchable?: true;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly status: Exclude<MessageStatus, "queued">;
  readonly order: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
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
  readonly activity: ActivityState;
  readonly nextOrder: number;
  readonly interactions: readonly InteractionPrompt[];
}

export const initialChatState: ChatState = {
  messages: [],
  queue: [],
  running: false,
  stopping: false,
  submissionError: undefined,
  failedRun: undefined,
  activeRun: undefined,
  activity: initialActivityState,
  nextOrder: 1,
  interactions: [],
};

export type ChatAction =
  | { readonly type: "initial-submit"; readonly id: string; readonly text: string; readonly at?: number }
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
  | { readonly type: "run-end"; readonly at?: number }
  | { readonly type: "backend-failed"; readonly error: string }
  | { readonly type: "interaction-request"; readonly request: DesktopInteractionRequest }
  | { readonly type: "interaction-answer"; readonly id: string; readonly answer: string }
  | { readonly type: "interaction-submit"; readonly id: string }
  | { readonly type: "interaction-resolved"; readonly id: string }
  | { readonly type: "interaction-failed"; readonly id: string; readonly error: string }
  | { readonly type: "activity"; readonly event: Exclude<DesktopAgentEvent, { type: "run-start" | "run-end" | "assistant-delta" | "assistant-complete" | "queue-update" | "context-usage" | "context-reset" }> }
  | { readonly type: "reset" }
  | { readonly type: "hydrate"; readonly messages: readonly RestoredTranscriptEntry[]; readonly todos: readonly RestoredTodo[]; readonly running?: boolean; readonly preserveDashboard?: true };

const finishLastAssistant = (
  messages: readonly TranscriptMessage[],
  status: "complete" | "stopped",
  completedAt?: number,
): readonly TranscriptMessage[] => {
  let index = -1;
  let latestAssistant = -1;
  for (let candidate = messages.length - 1; candidate >= 0; candidate -= 1) {
    const message = messages[candidate];
    if (message?.role === "assistant" && latestAssistant < 0) latestAssistant = candidate;
    if (message?.role === "assistant" && message.status === "streaming") {
      index = candidate;
      break;
    }
  }
  if (index < 0 && completedAt !== undefined) index = latestAssistant;
  if (index < 0) return messages;
  return messages.map((message, messageIndex) => messageIndex === index
    ? { ...message, ...(message.status === "streaming" ? { status } : {}), ...(completedAt === undefined ? {} : { completedAt }) }
    : message);
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
    interactions: [],
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
        messages: [...state.messages, { id: action.id, role: "user", text: action.text, status: "complete", order: state.nextOrder, startedAt: action.at ?? Date.now() }],
        queue: [],
        running: true,
        stopping: false,
        submissionError: undefined,
        failedRun: undefined,
        activeRun: { userId: action.id, text: action.text },
        interactions: [],
        nextOrder: state.nextOrder + 1,
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
        interactions: [],
      };
    case "request-failed":
      return failRun(state, action.userId, action.text, action.error);
    case "run-start":
      return { ...state, running: true, activity: activityReducer(state.activity, { type: "run-start" }) };
    case "assistant-delta": {
      const last = state.messages.at(-1);
      const messages = last?.role === "assistant" && last.status === "streaming"
        ? [...state.messages.slice(0, -1), { ...last, text: last.text + action.text }]
        : [...state.messages, { id: action.id, role: "assistant" as const, text: action.text, status: "streaming" as const, order: state.nextOrder }];
      return {
        ...state, messages, nextOrder: messages.length === state.messages.length ? state.nextOrder : state.nextOrder + 1,
        activity: activityReducer(state.activity, { type: "aggregation-complete" }),
      };
    }
    case "assistant-complete":
      return {
        ...state,
        messages: finishLastAssistant(state.messages, "complete"),
        activity: activityReducer(state.activity, { type: "aggregation-complete" }),
      };
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
          ...result.injected.map((item, index) => ({ id: `injected-${item.id}`, role: "user" as const, text: item.text, status: "complete" as const, order: state.nextOrder + index })),
        ],
        nextOrder: state.nextOrder + result.injected.length,
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
        messages: finishLastAssistant(state.messages, state.stopping ? "stopped" : "complete", action.at ?? Date.now()),
        queue: [],
        running: false,
        stopping: false,
        activeRun: undefined,
        interactions: [],
        activity: activityReducer(state.activity, { type: "settle", reason: "interrupted" }),
      };
    case "backend-failed": {
      const settled = { ...state, interactions: [], activity: activityReducer(state.activity, { type: "settle", reason: "interrupted" }) };
      if (!state.running || state.activeRun === undefined) return settled;
      return failRun(settled, state.activeRun.userId, state.activeRun.text, action.error);
    }
    case "activity": {
      const ordered = action.event.type === "tool-start" || action.event.type === "moa-reference-start" ||
        action.event.type === "moa-aggregating" || action.event.type === "advisor-note" || action.event.type === "subagent-start";
      return {
        ...state,
        activity: activityReducer(state.activity, ordered ? { ...action.event, order: state.nextOrder } : action.event),
        nextOrder: ordered ? state.nextOrder + 1 : state.nextOrder,
      };
    }
    case "interaction-request": {
      if (!state.running || state.interactions.some(prompt => prompt.id === action.request.id)) return state;
      const prompt: InteractionPrompt = action.request.type === "approval"
        ? { ...action.request, submitting: false, error: undefined }
        : { ...action.request, choices: action.request.choices, answer: "", submitting: false, error: undefined };
      return { ...state, interactions: [...state.interactions, prompt] };
    }
    case "interaction-answer":
      return {
        ...state,
        interactions: state.interactions.map(prompt => prompt.id === action.id && prompt.type === "clarification"
          ? { ...prompt, answer: action.answer, error: undefined }
          : prompt),
      };
    case "interaction-submit":
      return {
        ...state,
        interactions: state.interactions.map(prompt => prompt.id === action.id
          ? { ...prompt, submitting: true, error: undefined }
          : prompt),
      };
    case "interaction-resolved":
      return { ...state, interactions: state.interactions.filter(prompt => prompt.id !== action.id) };
    case "interaction-failed":
      return {
        ...state,
        interactions: state.interactions.map(prompt => prompt.id === action.id
          ? { ...prompt, submitting: false, error: action.error }
          : prompt),
      };
    case "hydrate":
      {
        const messages: TranscriptMessage[] = [];
        const entries: ActivityEntry[] = [];
        action.messages.forEach((item, index) => {
          const order = index + 1;
          if (item.role === "tool") {
            entries.push({ kind: "tool", id: item.id, name: item.name, status: item.failed ? "error" : "success", order, ...(item.target === undefined ? {} : { target: item.target }) });
            return;
          }
          messages.push({
            id: `restored-${String(order)}`,
            ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
            ...(item.branchable === undefined ? {} : { branchable: item.branchable }),
            ...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
            ...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
            role: item.role,
            text: item.text,
            status: "complete",
            order,
          });
        });
      return {
        ...initialChatState,
        messages,
        running: action.running ?? false,
        activity: {
          ...initialActivityState,
          entries,
          todos: action.todos,
          ...(action.preserveDashboard ? {
            subagents: state.activity.subagents,
            advisorNotes: state.activity.advisorNotes,
          } : {}),
        },
        nextOrder: action.messages.length + 1,
      };
      }
    case "reset":
      return initialChatState;
  }
};

/**
 * True when the thinking indicator should be visible:
 * the run is active AND the last message is not currently streaming.
 * Hides during streaming (the text itself is the progress indicator).
 */
export const shouldShowThinking = (state: ChatState): boolean => {
  if (!state.running) return false;
  const last = state.messages.at(-1);
  return last?.role !== "assistant" || last.status === "complete";
};
