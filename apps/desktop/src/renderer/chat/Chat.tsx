import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Bot, ChevronRight, FileText, FolderOpen, GitBranch, Globe, Search, Send, Square, Terminal, Wrench } from "lucide-react";
import type { OverlayScrollbars } from "overlayscrollbars";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import type { BackendSnapshot, DesktopAgentEvent, DesktopInteractionRequest, SessionSnapshot } from "../../shared/types";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/input";
import { EmptyState } from "../components/ui/state";
import { BackendStatus } from "../backendStatus";
import { chatReducer, initialChatState, shouldShowThinking } from "./chatState";
import type { InteractionPrompt, QueueKind } from "./chatState";
import type { ActivityEntry, ActivityState, ActivityStatus } from "./activityState";
import { presentGroupedToolActivity, presentToolActivity } from "./toolActivityPresentation";
import type { ToolActivityIcon } from "./toolActivityPresentation";
import type { TranscriptMessage } from "./chatState";
import { MarkdownMessage } from "./MarkdownMessage";
import { createDeltaFrameBuffer } from "./streaming";
import { errorMessage } from "../lib/utils";

const nextFrame = (callback: FrameRequestCallback): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : window.setTimeout(() => callback(performance.now()), 16);

const cancelFrame = (handle: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else window.clearTimeout(handle);
};

export const useChatController = (snapshot: BackendSnapshot | undefined) => {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const stateRef = useRef(state);
  const nextId = useRef(1);
  const stoppingRef = useRef(false);
  stateRef.current = state;
  stoppingRef.current = state.stopping;

  const makeId = useCallback((prefix: string): string => `${prefix}-${String(nextId.current++)}`, []);
  const deltaBuffer = useRef<ReturnType<typeof createDeltaFrameBuffer> | undefined>(undefined);
  if (deltaBuffer.current === undefined) {
    deltaBuffer.current = createDeltaFrameBuffer(
      text => dispatch({ type: "assistant-delta", id: makeId("assistant"), text }),
      nextFrame,
      cancelFrame,
    );
  }

  useEffect(() => {
    const handleEvent = (event: DesktopAgentEvent): void => {
      switch (event.type) {
        case "run-start": dispatch({ type: "run-start" }); break;
        case "run-end": deltaBuffer.current?.flush(); dispatch({ type: "run-end", at: Date.now() }); break;
        case "assistant-delta": deltaBuffer.current?.push(event.text); break;
        case "assistant-complete": deltaBuffer.current?.flush(); dispatch({ type: "assistant-complete" }); break;
        case "queue-update": dispatch({ type: "queue-update", steering: event.steering, followUp: event.followUp }); break;
        case "context-usage":
        case "context-reset": break;
        default: dispatch({ type: "activity", event }); break;
      }
    };
    const unsubscribe = window.railgunDesktop.onAgentEvent(handleEvent);
    return () => { deltaBuffer.current?.clear(); unsubscribe(); };
  }, []);

  useEffect(() => {
    const handleInteraction = (request: DesktopInteractionRequest): void => {
      dispatch({ type: "interaction-request", request });
    };
    const unsubscribe = window.railgunDesktop.onInteractionRequest(handleInteraction);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (snapshot !== undefined && snapshot.phase !== "ready") {
      deltaBuffer.current?.flush();
      dispatch({ type: "backend-failed", error: snapshot.error ?? "The backend connection was interrupted" });
    }
  }, [snapshot?.phase, snapshot?.error]);

  const performInitial = async (userId: string, text: string): Promise<void> => {
    try {
      await window.railgunDesktop.sendPrompt(text);
    } catch (error) {
      deltaBuffer.current?.flush();
      dispatch({ type: "request-failed", userId, text, error: errorMessage(error, "The request failed") });
    }
  };

  const sendInitial = async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || snapshot?.phase !== "ready" || stateRef.current.running) return;
    const userId = makeId("user");
    setDraft("");
    dispatch({ type: "initial-submit", id: userId, text, at: Date.now() });
    await performInitial(userId, text);
  };

  const retry = async (): Promise<void> => {
    const failedRun = stateRef.current.failedRun;
    if (failedRun === undefined || snapshot?.phase !== "ready" || stateRef.current.running) return;
    dispatch({ type: "retry-start" });
    await performInitial(failedRun.userId, failedRun.text);
  };

  const queueDraft = async (kind: QueueKind): Promise<void> => {
    const source = draft;
    const text = source.trim();
    if (text === "" || snapshot?.phase !== "ready" || !stateRef.current.running || stateRef.current.stopping) return;
    try {
      if (kind === "steering") await window.railgunDesktop.steerPrompt(text);
      else await window.railgunDesktop.followUpPrompt(text);
      if (!stateRef.current.running || stateRef.current.stopping) return;
      dispatch({ type: "queue-accepted", id: makeId("queued"), kind, text });
      setDraft(current => current === source ? "" : current);
    } catch (error) {
      dispatch({ type: "queue-rejected", error: errorMessage(error, `Unable to queue ${kind}`) });
    }
  };

  const stop = async (): Promise<boolean> => {
    if (!stateRef.current.running || stoppingRef.current) return false;
    stoppingRef.current = true;
    dispatch({ type: "stop-request" });
    try {
      await window.railgunDesktop.abortPrompt();
      dispatch({ type: "stop-acknowledged" });
      return true;
    } catch (error) {
      stoppingRef.current = false;
      dispatch({ type: "stop-failed", error: errorMessage(error, "Unable to stop the request") });
      return false;
    }
  };

  const stopAndWait = async (): Promise<boolean> => {
    if (!await stop()) return false;
    if (!stateRef.current.running) return true;
    return new Promise(resolve => {
      const deadline = Date.now() + 5_000;
      const check = (): void => {
        if (!stateRef.current.running) resolve(true);
        else if (Date.now() >= deadline) resolve(false);
        else window.setTimeout(check, 25);
      };
      check();
    });
  };

  const setInteractionAnswer = (id: string, answer: string): void => {
    dispatch({ type: "interaction-answer", id, answer });
  };

  const respondToApproval = async (id: string, approved: boolean): Promise<void> => {
    dispatch({ type: "interaction-submit", id });
    try {
      await window.railgunDesktop.respondToApproval(id, approved);
      dispatch({ type: "interaction-resolved", id });
    } catch (error) {
      dispatch({ type: "interaction-failed", id, error: errorMessage(error, "Unable to submit approval") });
    }
  };

  const respondToClarification = async (id: string, answer: string): Promise<void> => {
    dispatch({ type: "interaction-submit", id });
    try {
      await window.railgunDesktop.respondToClarification(id, answer);
      dispatch({ type: "interaction-resolved", id });
    } catch (error) {
      dispatch({ type: "interaction-failed", id, error: errorMessage(error, "Unable to submit clarification") });
    }
  };

  const reset = (): void => {
    deltaBuffer.current?.clear();
    setDraft("");
    dispatch({ type: "reset" });
  };

  const hydrate = (snapshot: SessionSnapshot): void => {
    deltaBuffer.current?.clear();
    setDraft("");
    dispatch({ type: "hydrate", messages: snapshot.transcript, todos: snapshot.todos });
  };

  return { state, draft, setDraft, sendInitial, retry, queueDraft, stop, stopAndWait, reset, hydrate, setInteractionAnswer, respondToApproval, respondToClarification };
};

export type ChatController = ReturnType<typeof useChatController>;

const STATUS_LABEL: Record<ActivityStatus, string> = {
  running: "Running", success: "Completed", error: "Error", interrupted: "Interrupted",
};
const TODO_STATUS_LABEL: Record<ActivityState["todos"][number]["status"], string> = {
  pending: "Pending", in_progress: "In progress", completed: "Completed", cancelled: "Cancelled",
};
const TODO_STATUS_ICON: Record<ActivityState["todos"][number]["status"], string> = {
  pending: "○", in_progress: "→", completed: "✓", cancelled: "×",
};
const SUBAGENT_STATUS_LABEL: Record<ActivityState["subagents"][number]["status"], string> = {
  running: "Running", completed: "Completed", interrupted: "Interrupted",
};

const ToolActivityGlyph = ({ icon }: { readonly icon: ToolActivityIcon }): React.JSX.Element => {
  const Icon = icon === "file-edit" || icon === "file-read" ? FileText
    : icon === "folder" ? FolderOpen
      : icon === "terminal" ? Terminal
        : icon === "search" ? Search
          : icon === "globe" ? Globe
            : Wrench;
  return <Icon aria-hidden="true" />;
};

const ActivityRow = ({ entry }: { readonly entry: ActivityEntry }): React.JSX.Element => {
  if (entry.kind === "advisor") return (
    <article className={`activity-row advisor-row ${entry.severity}`}>
      <div className="activity-label">Advisor {entry.severity}</div><p>{entry.text}</p>
    </article>
  );
  if (entry.kind === "moa-aggregation") return (
    <article className={`activity-row moa-row ${entry.status}`}>
      <div><span className="activity-label">Aggregating {entry.refCount} {entry.refCount === 1 ? "reference" : "references"}</span><span className="activity-status">{STATUS_LABEL[entry.status]}</span></div>
      <p>{entry.model}</p>
    </article>
  );
  if (entry.kind === "moa-reference") return (
    <article className={`activity-row moa-row ${entry.status}`}>
      <div><span className="activity-label">Reference {entry.index + 1} of {entry.count}</span><span className="activity-status">{STATUS_LABEL[entry.status]}</span></div>
      <p>{entry.model}</p>{entry.preview === undefined ? null : <p className="activity-preview">{entry.preview}</p>}
    </article>
  );
  const status = STATUS_LABEL[entry.status];
  const presentation = presentToolActivity(entry.name, entry.input, entry.status, entry.target);
  return (
    <details className={`activity-row tool-row ${entry.status}`} aria-label={`${entry.name} — ${status}`}>
      <summary>
        <span className="tool-activity-icon"><ToolActivityGlyph icon={presentation.icon} /></span>
        <span className="tool-activity-copy"><span className="activity-label">{presentation.action}</span>{presentation.target === undefined ? null : <span className="tool-activity-target">{presentation.target}</span>}</span>
      </summary>
      {entry.input === undefined ? null : <div className="tool-activity-details"><h3>Input</h3><pre>{entry.input}</pre></div>}
      {entry.output === undefined ? null : <div className="tool-activity-details"><h3>Output</h3><pre>{entry.output}</pre></div>}
    </details>
  );
};

type ToolActivityEntry = Extract<ActivityEntry, { readonly kind: "tool" }>;
export interface ToolActivityGroup {
  readonly kind: "tool-group";
  readonly name: string;
  readonly status: ActivityStatus;
  readonly entries: readonly ToolActivityEntry[];
}

type ActivityRowItem = ActivityEntry | ToolActivityGroup;

const groupedToolStatus = (entries: readonly ToolActivityEntry[]): ActivityStatus => {
  if (entries.some(entry => entry.status === "running")) return "running";
  if (entries.some(entry => entry.status === "error")) return "error";
  if (entries.some(entry => entry.status === "interrupted")) return "interrupted";
  return "success";
};

export const groupConsecutiveToolActivities = (entries: readonly ActivityEntry[]): readonly ActivityRowItem[] => {
  const grouped: ActivityRowItem[] = [];
  let consecutiveTools: ToolActivityEntry[] = [];
  const flush = (): void => {
    if (consecutiveTools.length === 1) grouped.push(consecutiveTools[0]!);
    else if (consecutiveTools.length > 1) grouped.push({
      kind: "tool-group",
      name: consecutiveTools[0]!.name,
      status: groupedToolStatus(consecutiveTools),
      entries: consecutiveTools,
    });
    consecutiveTools = [];
  };
  for (const entry of entries) {
    if (entry.kind === "tool" && (consecutiveTools.length === 0 || consecutiveTools[0]!.name === entry.name)) {
      consecutiveTools.push(entry);
      continue;
    }
    flush();
    if (entry.kind === "tool") consecutiveTools.push(entry);
    else grouped.push(entry);
  }
  flush();
  return grouped;
};

export const toolActivityGroupKey = (group: ToolActivityGroup): string =>
  `tool-group-${group.name}-${group.entries.map(entry => String(entry.order)).join("-")}`;

const ActivityRows = ({ entries }: { readonly entries: readonly ActivityEntry[] }): React.JSX.Element => <>
  {groupConsecutiveToolActivities(entries).map(entry => entry.kind === "tool-group"
    ? <ToolActivityGroupRow key={toolActivityGroupKey(entry)} group={entry} />
    : <ActivityRow entry={entry} key={`${entry.id}-${String(entry.order)}`} />)}
</>;

const ToolActivityGroupRow = ({ group }: { readonly group: ToolActivityGroup }): React.JSX.Element => {
  const presentation = presentGroupedToolActivity(group.name, group.status);
  const uses = `${String(group.entries.length)} tool ${group.entries.length === 1 ? "use" : "uses"}`;
  return (
    <details className={`activity-row tool-row tool-activity-group ${group.status}`} aria-label={`${presentation.action} — ${uses}`}>
      <summary>
        <span className="tool-activity-icon"><ToolActivityGlyph icon={presentation.icon} /></span>
        <span className="tool-activity-copy"><span className="activity-label">{presentation.action}</span></span>
        <ChevronRight className="tool-activity-group-chevron" aria-hidden="true" />
      </summary>
      <div className="tool-activity-group-entries">{group.entries.map(entry => <ActivityRow entry={entry} key={`${entry.id}-${String(entry.order)}`} />)}</div>
    </details>
  );
};

export const ActivityInspector = ({ activity }: { readonly activity: ActivityState }): React.JSX.Element => {
  if (activity.todos.length === 0 && activity.subagents.length === 0 && !activity.todoLoading) return <></>;
  const completed = activity.todos.filter(todo => todo.status === "completed").length;
  return (
    <div className="activity-inspector" role="region" aria-label="Agent activity inspector">
      {activity.todoLoading || activity.todos.length > 0 ? <section aria-labelledby="todo-heading">
        <header><h2 id="todo-heading">Todos</h2>{activity.todoLoading
          ? <span className="inspector-loading" role="status">Updating todos…</span>
          : <span>{completed} of {activity.todos.length} complete</span>}</header>
        <ol>{activity.todos.map(todo => <li key={todo.id} className={todo.status}>
          <span className="todo-indicator" aria-hidden="true">{TODO_STATUS_ICON[todo.status]}</span>
          <span className="todo-content">{todo.content}</span><span className="todo-status">{TODO_STATUS_LABEL[todo.status]}</span>
        </li>)}</ol>
      </section> : null}
      {activity.subagents.length > 0 ? <section aria-labelledby="subagent-heading">
        <header><h2 id="subagent-heading">Subagents</h2></header>
        <ol>{activity.subagents.map(subagent => <li key={subagent.index}>
          <span className="todo-content">{subagent.goal}</span>
          <span className="subagent-status">{SUBAGENT_STATUS_LABEL[subagent.status]}</span>
          {subagent.result === undefined ? null : <p>{subagent.result}</p>}
        </li>)}</ol>
      </section> : null}
    </div>
  );
};

type TranscriptEntry =
  | { readonly kind: "message"; readonly order: number; readonly message: TranscriptMessage }
  | { readonly kind: "activity"; readonly order: number; readonly activity: ActivityEntry };

type TranscriptPresentationEntry =
  | { readonly kind: "entry"; readonly entry: TranscriptEntry }
  | { readonly kind: "worked"; readonly activities: readonly ActivityEntry[]; readonly durationMs?: number; readonly key: string };

type TranscriptRenderEntry = TranscriptPresentationEntry
  | { readonly kind: "activity-list"; readonly activities: readonly ActivityEntry[]; readonly key: string };

const formatWorkedDuration = (durationMs: number | undefined): string => {
  if (durationMs === undefined) return "Worked";
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  return seconds < 60 ? `Worked for ${String(seconds)}s` : `Worked for ${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
};

export const collapseCompletedTurnActivity = (
  entries: readonly TranscriptEntry[],
  isRunning: boolean,
): readonly TranscriptPresentationEntry[] => {
  if (isRunning) return entries.map(entry => ({ kind: "entry", entry }));
  const result: TranscriptPresentationEntry[] = [];
  let user: TranscriptMessage | undefined;
  let activities: ActivityEntry[] = [];
  const flushActivities = (): void => {
    result.push(...activities.map(activity => ({ kind: "entry" as const, entry: { kind: "activity" as const, order: activity.order, activity } })));
    activities = [];
  };
  for (const entry of entries) {
    if (entry.kind === "activity" && user !== undefined) {
      activities.push(entry.activity);
      continue;
    }
    if (entry.kind === "message" && entry.message.role === "user") {
      flushActivities();
      user = entry.message;
      result.push({ kind: "entry", entry });
      continue;
    }
    if (entry.kind === "message" && entry.message.role === "assistant") {
      const completesTurn = entry.message.status === "complete" && (entry.message.branchable === true || entry.message.messageId === undefined);
      if (user !== undefined && completesTurn && activities.length > 0) {
        const durationMs = user.startedAt === undefined || entry.message.completedAt === undefined
          ? undefined
          : Math.max(0, entry.message.completedAt - user.startedAt);
        result.push({ kind: "worked", activities, ...(durationMs === undefined ? {} : { durationMs }), key: `worked-${String(user.order)}-${String(entry.message.order)}` });
        activities = [];
      } else if (completesTurn) {
        flushActivities();
      }
      if (completesTurn) user = undefined;
    }
    result.push({ kind: "entry", entry });
  }
  flushActivities();
  return result;
};

const groupConsecutiveTranscriptActivities = (entries: readonly TranscriptPresentationEntry[]): readonly TranscriptRenderEntry[] => {
  const grouped: TranscriptRenderEntry[] = [];
  let activities: ActivityEntry[] = [];
  const flush = (): void => {
    if (activities.length > 0) {
      grouped.push({ kind: "activity-list", activities, key: `activities-${activities.map(activity => activity.id).join("-")}` });
      activities = [];
    }
  };
  for (const entry of entries) {
    if (entry.kind === "entry" && entry.entry.kind === "activity") {
      activities.push(entry.entry.activity);
      continue;
    }
    flush();
    grouped.push(entry);
  }
  flush();
  return grouped;
};

export const WorkedActivityGroup = ({ activities, durationMs }: { readonly activities: readonly ActivityEntry[]; readonly durationMs?: number }): React.JSX.Element => (
  <details className="worked-activity-group">
    <summary><span>{formatWorkedDuration(durationMs)}</span><span className="worked-activity-chevron" aria-hidden="true">›</span></summary>
    <div><ActivityRows entries={activities} /></div>
  </details>
);

interface TranscriptProps {
  readonly controller: ChatController;
  readonly snapshot: BackendSnapshot;
  readonly onRestart: () => Promise<void>;
  readonly canBranch?: boolean;
  readonly onBranch?: (messageId: number) => void;
}

const transcriptScrollOptions = {
  overflow: { x: "hidden", y: "scroll" },
  scrollbars: { visibility: "hidden" },
} as const;

const TRANSCRIPT_MAX_DASH_COUNT = 24;
const TRANSCRIPT_ACTIVE_DASH_COUNT = 4;
const TRANSCRIPT_BOTTOM_TOLERANCE = 4;
const TRANSCRIPT_DASH_GROWTH_PX = 96;
const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

export const transcriptActiveDashIndexes = (progress: number, dashCount = TRANSCRIPT_MAX_DASH_COUNT): readonly number[] => {
  const activeDashCount = Math.min(TRANSCRIPT_ACTIVE_DASH_COUNT, dashCount);
  const start = Math.round(clampUnit(progress) * (dashCount - activeDashCount));
  return Array.from({ length: activeDashCount }, (_, index) => start + index);
};

type ScrollMetrics = Readonly<Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">>;

export const transcriptScrollProgress = ({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics): number => {
  const scrollableHeight = scrollHeight - clientHeight;
  return scrollableHeight <= 0 ? 0 : clampUnit(scrollTop / scrollableHeight);
};

export const transcriptIsAtBottom = ({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics): boolean => {
  const scrollableHeight = scrollHeight - clientHeight;
  return scrollableHeight <= 0 || scrollableHeight - scrollTop <= TRANSCRIPT_BOTTOM_TOLERANCE;
};

export const transcriptIndicatorDashCount = ({ scrollHeight, clientHeight }: ScrollMetrics): number => {
  const scrollableHeight = scrollHeight - clientHeight;
  if (scrollableHeight <= 0) return 0;
  return Math.min(TRANSCRIPT_MAX_DASH_COUNT, TRANSCRIPT_ACTIVE_DASH_COUNT + Math.floor(scrollableHeight / TRANSCRIPT_DASH_GROWTH_PX));
};

interface TranscriptScrollPresentation {
  readonly progress: number;
  readonly dashCount: number;
}

const initialTranscriptScrollPresentation: TranscriptScrollPresentation = { progress: 0, dashCount: 0 };

const TranscriptScrollIndicator = ({ progress, dashCount }: { readonly progress: number; readonly dashCount: number }): React.JSX.Element | null => {
  if (dashCount === 0) return null;
  const activeDashes = transcriptActiveDashIndexes(progress, dashCount);
  const dashIndexes = Array.from({ length: dashCount }, (_, index) => index);
  return (
    <div className="transcript-scroll-indicator" aria-hidden="true" style={{ "--transcript-indicator-dash-count": dashCount } as CSSProperties}>
      {dashIndexes.map(index => <span className={activeDashes.includes(index) ? "active" : undefined} key={index} />)}
    </div>
  );
};

export const Transcript = ({ controller, snapshot, onRestart, canBranch, onBranch }: TranscriptProps): React.JSX.Element => {
  const { state } = controller;
  const [scrollPresentation, setScrollPresentation] = useState(initialTranscriptScrollPresentation);
  const followTranscript = useRef(true);
  const automaticScrollTop = useRef<number | undefined>(undefined);
  const updateScrollPresentation = useCallback((instance: OverlayScrollbars): void => {
    const scrollElement = instance.elements().scrollOffsetElement;
    const progress = transcriptScrollProgress(scrollElement);
    const dashCount = transcriptIndicatorDashCount(scrollElement);
    setScrollPresentation(current => {
      if (current.progress === progress && current.dashCount === dashCount) return current;
      return { progress, dashCount };
    });
  }, []);
  const scrollTranscriptToBottom = useCallback((instance: OverlayScrollbars): void => {
    const scrollElement = instance.elements().scrollOffsetElement;
    const bottom = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    automaticScrollTop.current = bottom;
    scrollElement.scrollTop = bottom;
  }, []);
  const initializeTranscriptScroll = useCallback((instance: OverlayScrollbars): void => {
    followTranscript.current = true;
    scrollTranscriptToBottom(instance);
    updateScrollPresentation(instance);
  }, [scrollTranscriptToBottom, updateScrollPresentation]);
  const handleTranscriptUpdated = useCallback((instance: OverlayScrollbars): void => {
    if (followTranscript.current) scrollTranscriptToBottom(instance);
    updateScrollPresentation(instance);
  }, [scrollTranscriptToBottom, updateScrollPresentation]);
  const handleTranscriptScroll = useCallback((instance: OverlayScrollbars): void => {
    const scrollElement = instance.elements().scrollOffsetElement;
    const automaticTarget = automaticScrollTop.current;
    const matchesAutomaticScroll = automaticTarget !== undefined
      && Math.abs(scrollElement.scrollTop - automaticTarget) <= TRANSCRIPT_BOTTOM_TOLERANCE;
    if (!matchesAutomaticScroll) {
      automaticScrollTop.current = undefined;
      followTranscript.current = transcriptIsAtBottom(scrollElement);
    }
    updateScrollPresentation(instance);
  }, [updateScrollPresentation]);
  const entries: TranscriptEntry[] = [
    ...state.messages.map(message => ({ kind: "message" as const, order: message.order, message })),
    ...state.activity.entries.map(activity => ({ kind: "activity" as const, order: activity.order, activity })),
  ].sort((left, right) => left.order - right.order);
  const presentationEntries = groupConsecutiveTranscriptActivities(collapseCompletedTurnActivity(entries, state.running));
  const empty = entries.length === 0;
  return (
    <div className="transcript-stage">
      <OverlayScrollbarsComponent
        className="transcript"
        options={transcriptScrollOptions}
        events={{ initialized: initializeTranscriptScroll, updated: handleTranscriptUpdated, scroll: handleTranscriptScroll }}
      >
        <div className={`transcript-content ${empty ? "empty" : ""}`} aria-live="polite">
          {empty && snapshot.phase === "ready"
            ? <EmptyState className="welcome" icon={<Bot />} title="What are we building?" description="Ask Railgun to inspect, explain, or change your project." />
            : null}
          {empty && snapshot.phase !== "ready"
            ? <BackendStatus snapshot={snapshot} onRetry={onRestart} />
            : null}
          {presentationEntries.map(item => {
            if (item.kind === "worked") return <WorkedActivityGroup key={item.key} activities={item.activities} {...(item.durationMs === undefined ? {} : { durationMs: item.durationMs })} />;
            if (item.kind === "activity-list") return <ActivityRows entries={item.activities} key={item.key} />;
            const entry = item.entry;
            if (entry.kind === "activity") return <ActivityRows entries={[entry.activity]} key={`activity-${entry.activity.id}-${entry.activity.order}`} />;
            const message = entry.message;
            return <article className={`message ${message.role} ${message.status}`} key={message.id} data-status={message.status}>
              {message.role === "assistant" && message.status !== "streaming"
                ? <MarkdownMessage>{message.text}</MarkdownMessage>
                : <p>{message.text}</p>}
              {message.status === "stopped" ? <span className="message-status">Stopped</span> : null}
              {canBranch && onBranch !== undefined && message.branchable && message.messageId !== undefined && entries.some(candidate => candidate.kind === "message" && candidate.order > entry.order) ? <Button
                type="button"
                className="branch-message-action"
                size="sm"
                variant="ghost"
                onClick={() => onBranch(message.messageId!)}
              ><GitBranch aria-hidden="true" />Branch from this message</Button> : null}
            </article>;
          })}
          {state.failedRun === undefined ? null : (
            <div className="run-error" role="alert">
              <span>{state.failedRun.error}</span>
              {snapshot.phase === "ready"
                ? <Button type="button" size="sm" variant="tonal" onClick={() => void controller.retry()}>Retry</Button>
                : <Button type="button" size="sm" variant="tonal" onClick={() => void onRestart()}>Restart backend</Button>}
            </div>
          )}
          {shouldShowThinking(state)
            ? <div className="thinking"><i /><i /><i /><span>Railgun is thinking</span></div>
            : null}
        </div>
      </OverlayScrollbarsComponent>
      <TranscriptScrollIndicator progress={scrollPresentation.progress} dashCount={scrollPresentation.dashCount} />
    </div>
  );
};

interface ComposerProps {
  readonly controller: ChatController;
  readonly available: boolean;
  readonly controls?: ReactNode;
}

const declineAnswer = "[user declined to answer]";

interface InteractionPromptProps {
  readonly prompt: InteractionPrompt;
  readonly onAnswer: (id: string, answer: string) => Promise<void>;
  readonly onApproval: (id: string, approved: boolean) => Promise<void>;
  readonly onSelectAnswer: (id: string, answer: string) => void;
}

const InteractionPromptCard = ({ prompt, onAnswer, onApproval, onSelectAnswer }: InteractionPromptProps): React.JSX.Element => {
  const firstControl = useRef<HTMLInputElement>(null);
  const approvalControl = useRef<HTMLButtonElement>(null);
  const choiceRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (prompt.type === "approval") approvalControl.current?.focus();
    else if (firstControl.current !== null) firstControl.current.focus();
    else choiceRefs.current[0]?.focus();
  }, [prompt.type]);

  const decline = (): void => {
    if (prompt.submitting) return;
    if (prompt.type === "approval") void onApproval(prompt.id, false);
    else void onAnswer(prompt.id, declineAnswer);
  };

  const choices = prompt.type === "clarification" ? prompt.choices : undefined;
  return prompt.type === "approval" ? (
    <section className="interaction-prompt approval-prompt" aria-label="Shell command approval" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); decline(); }
    }}>
      <div className="interaction-prompt-heading"><p className="eyebrow">Approval needed</p><h2>Allow this shell command?</h2></div>
      <pre className="interaction-command" aria-label="Command preview">{prompt.command}</pre>
      {prompt.error === undefined ? null : <p className="interaction-error" role="alert">{prompt.error}</p>}
      <div className="interaction-actions">
        <Button ref={approvalControl} type="button" variant="tonal" disabled={prompt.submitting} onClick={() => void onApproval(prompt.id, false)}>Deny</Button>
        <Button type="button" disabled={prompt.submitting} onClick={() => void onApproval(prompt.id, true)}>{prompt.submitting ? "Submitting…" : "Allow"}</Button>
      </div>
    </section>
  ) : (
    <section className="interaction-prompt clarification-prompt" aria-label="Clarification request" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); decline(); }
    }}>
      <div className="interaction-prompt-heading"><p className="eyebrow">Clarification needed</p><h2>{prompt.question}</h2></div>
      {choices === undefined ? (
        <form onSubmit={event => { event.preventDefault(); if (prompt.answer.trim() !== "") void onAnswer(prompt.id, prompt.answer); }}>
          <label className="interaction-label" htmlFor={`clarification-${prompt.id}`}>Your answer</label>
          <input
            ref={firstControl}
            id={`clarification-${prompt.id}`}
            className="ui-field ui-input"
            value={prompt.answer}
            maxLength={100_000}
            disabled={prompt.submitting}
            onChange={event => onSelectAnswer(prompt.id, event.target.value)}
          />
          <div className="interaction-actions">
            <Button type="button" variant="tonal" disabled={prompt.submitting} onClick={decline}>Decline</Button>
            <Button type="submit" disabled={prompt.submitting || prompt.answer.trim() === ""}>{prompt.submitting ? "Submitting…" : "Submit"}</Button>
          </div>
        </form>
      ) : (
        <div role="radiogroup" aria-label="Clarification choices" className="interaction-choices">
          {choices.map((choice, index) => (
            <Button
              type="button"
              role="radio"
              aria-checked={prompt.answer === choice}
              className="interaction-choice"
              key={choice}
              ref={element => { choiceRefs.current[index] = element; }}
              disabled={prompt.submitting}
              onClick={() => { onSelectAnswer(prompt.id, choice); void onAnswer(prompt.id, choice); }}
              onKeyDown={event => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowLeft" && event.key !== "Enter") return;
                event.preventDefault();
                if (event.key === "Enter") {
                  void onAnswer(prompt.id, prompt.answer || choice);
                  return;
                }
                const offset = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
                choiceRefs.current[(index + offset + choices.length) % choices.length]?.focus();
              }}
            >{choice}</Button>
          ))}
        </div>
      )}
      {prompt.error === undefined ? null : <p className="interaction-error" role="alert">{prompt.error}</p>}
    </section>
  );
};

const InteractionPrompts = ({ controller }: { readonly controller: ChatController }): React.JSX.Element => (
  <div className="interaction-prompts" aria-label="Pending agent prompts">
    {controller.state.interactions.map(prompt => <InteractionPromptCard
      key={prompt.id}
      prompt={prompt}
      onAnswer={controller.respondToClarification}
      onApproval={controller.respondToApproval}
      onSelectAnswer={controller.setInteractionAnswer}
    />)}
  </div>
);

export const Composer = ({ controller, available, controls }: ComposerProps): React.JSX.Element => {
  const { state, draft } = controller;
  const interactionsOpen = state.interactions.length > 0;
  return (
    <div className="composer-wrap">
      <InteractionPrompts controller={controller} />
      {state.queue.length === 0 ? null : (
        <section className="prompt-queue" aria-label="Queued messages">
          <h2>Queued</h2>
          <ol>{state.queue.map(item => <li key={item.id}><span>{item.kind === "steering" ? "Steering" : "Follow-up"}</span><p>{item.text}</p></li>)}</ol>
        </section>
      )}
      <div className="composer">
        <Textarea
          aria-label="Message Railgun"
          placeholder={available ? "Message Railgun…" : "Backend unavailable"}
          value={draft}
          disabled={!available || interactionsOpen}
          onChange={event => controller.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (state.running) void controller.queueDraft("steering");
              else void controller.sendInitial();
            } else if (event.key === "Tab" && state.running && draft.trim() !== "") {
              event.preventDefault();
              void controller.queueDraft("follow-up");
            }
          }}
        />
        <div className="composer-footer">
          {controls === undefined ? null : <div className="composer-controls">{controls}</div>}
          {state.running ? (
            <Button variant="destructive" size="icon" className="send-button" aria-label="Stop" disabled={state.stopping} onClick={() => void controller.stop()}><Square aria-hidden="true" /></Button>
          ) : (
            <Button size="icon" className="send-button" aria-label="Send" disabled={draft.trim() === "" || !available} onClick={() => void controller.sendInitial()}><Send aria-hidden="true" /></Button>
          )}
        </div>
      </div>
      {state.submissionError === undefined ? null : <p className="composer-error" role="alert">{state.submissionError}</p>}
      <p className="composer-hint">{interactionsOpen ? "Answer the pending prompt to continue" : state.running ? "Enter steers · Tab queues follow-up · Shift+Enter adds a line" : "Enter sends · Shift+Enter adds a line"}</p>
    </div>
  );
};
