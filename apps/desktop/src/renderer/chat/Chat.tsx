import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Bot, ChevronRight, FileText, FolderOpen, GitBranch, Globe, Lightbulb, Search, Send, Square, Terminal, Wrench } from "lucide-react";
import type { OverlayScrollbars } from "overlayscrollbars";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import type { BackendSnapshot, DesktopAgentEvent, DesktopInteractionRequest, SessionSnapshot } from "../../shared/types";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/input";
import { EmptyState } from "../components/ui/state";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/ui/hover-card";
import { BackendStatus } from "../backendStatus";
import { chatReducer, initialChatState, shouldShowThinking } from "./chatState";
import type { InteractionPrompt, QueueKind } from "./chatState";
import type { ActivityEntry, ActivityState, ActivityStatus } from "./activityState";
import { presentGroupedToolActivity, presentToolActivity } from "./toolActivityPresentation";
import type { ToolActivityIcon } from "./toolActivityPresentation";
import type { TranscriptMessage } from "./chatState";
import { MarkdownMessage } from "./MarkdownMessage";
import { createDeltaFrameBuffer } from "./streaming";
import { cn, errorMessage } from "../lib/utils";

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

  const refresh = (snapshot: SessionSnapshot): void => {
    deltaBuffer.current?.clear();
    dispatch({ type: "hydrate", messages: snapshot.transcript, todos: snapshot.todos, preserveDashboard: true });
  };

  return { state, draft, setDraft, sendInitial, retry, queueDraft, stop, stopAndWait, reset, hydrate, refresh, setInteractionAnswer, respondToApproval, respondToClarification };
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

const activityRowClass = (status: ActivityStatus): string => cn(
  "mx-auto mb-4 w-full max-w-content rounded-sm border border-border bg-surface-muted px-4 py-3 text-control",
  status === "error" && "border-destructive/55",
  status === "success" && "border-success/40",
  status === "interrupted" && "border-warning/50",
);
const activityHeadingClass = "flex items-center justify-between gap-3";
const activityLabelClass = "font-semibold";
const activityStatusClass = "text-caption text-foreground-secondary";

const ActivityRow = ({ entry }: { readonly entry: ActivityEntry }): React.JSX.Element => {
  if (entry.kind === "moa-aggregation") return (
    <article className={activityRowClass(entry.status)}>
      <div className={activityHeadingClass}><span className={activityLabelClass}>Aggregating {entry.refCount} {entry.refCount === 1 ? "reference" : "references"}</span><span className={activityStatusClass}>{STATUS_LABEL[entry.status]}</span></div>
      <p className="mb-0 mt-1 [overflow-wrap:anywhere]">{entry.model}</p>
    </article>
  );
  if (entry.kind === "moa-reference") return (
    <article className={activityRowClass(entry.status)}>
      <div className={activityHeadingClass}><span className={activityLabelClass}>Reference {entry.index + 1} of {entry.count}</span><span className={activityStatusClass}>{STATUS_LABEL[entry.status]}</span></div>
      <p className="mb-0 mt-1 [overflow-wrap:anywhere]">{entry.model}</p>{entry.preview === undefined ? null : <p className="mb-0 mt-1 text-foreground-secondary">{entry.preview}</p>}
    </article>
  );
  const status = STATUS_LABEL[entry.status];
  const presentation = presentToolActivity(entry.name, entry.input, entry.status, entry.target);
  return (
    <details className={cn("tool-row group/tool-row mx-auto mb-3 w-full max-w-content transition-opacity duration-fast focus-within:opacity-100 hover:opacity-100 open:opacity-100", entry.status === "success" ? "opacity-55" : "opacity-100", entry.status === "error" && "text-destructive", entry.status === "interrupted" && "text-warning")} aria-label={`${entry.name} — ${status}`}>
      <summary className="flex cursor-pointer list-none items-center justify-start gap-2">
        <span className="tool-activity-icon grid size-[1.125rem] shrink-0 place-items-center text-foreground-tertiary [&_svg]:size-4"><ToolActivityGlyph icon={presentation.icon} /></span>
        <span className="flex min-w-0 items-baseline gap-1 overflow-hidden"><span className="shrink-0 font-medium">{presentation.action}</span>{presentation.target === undefined ? null : <span className="truncate font-mono text-foreground-secondary">{presentation.target}</span>}</span>
      </summary>
      {entry.input === undefined ? null : <div className="mb-0 ml-[calc(1.125rem+var(--space-2))] mt-2 p-0 [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-caption [&_h3]:uppercase [&_h3]:text-foreground-secondary [&_pre]:m-0 [&_pre]:max-h-72 [&_pre]:text-caption"><h3>Input</h3><pre>{entry.input}</pre></div>}
      {entry.output === undefined ? null : <div className="mb-0 ml-[calc(1.125rem+var(--space-2))] mt-2 p-0 [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-caption [&_h3]:uppercase [&_h3]:text-foreground-secondary [&_pre]:m-0 [&_pre]:max-h-72 [&_pre]:text-caption"><h3>Output</h3><pre>{entry.output}</pre></div>}
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
    <details className={cn("tool-activity-group group/tool-group mx-auto mb-3 w-full max-w-content transition-opacity duration-fast focus-within:opacity-100 hover:opacity-100 open:opacity-100", group.status === "success" ? "opacity-55" : "opacity-100")} aria-label={`${presentation.action} — ${uses}`}>
      <summary className="flex cursor-pointer list-none items-center justify-start gap-2">
        <span className="tool-activity-icon grid size-[1.125rem] shrink-0 place-items-center text-foreground-tertiary [&_svg]:size-4"><ToolActivityGlyph icon={presentation.icon} /></span>
        <span className="flex min-w-0 items-baseline gap-1 overflow-hidden"><span className="shrink-0 font-medium">{presentation.action}</span></span>
        <ChevronRight className="tool-activity-group-chevron size-3.5 shrink-0 text-foreground-secondary transition-transform duration-fast group-open/tool-group:rotate-90" aria-hidden="true" />
      </summary>
      <div className="pl-7 pt-3 [&>*:last-child]:mb-0">{group.entries.map(entry => <ActivityRow entry={entry} key={`${entry.id}-${String(entry.order)}`} />)}</div>
    </details>
  );
};

const DashboardAgentRow = ({
  label,
  status,
  icon,
  advisor = false,
  children,
}: {
  readonly label: string;
  readonly status: string;
  readonly icon: ReactNode;
  readonly advisor?: boolean;
  readonly children: ReactNode;
}): React.JSX.Element => (
  <DashboardAgentHoverCard label={label} status={status} icon={icon} advisor={advisor}>{children}</DashboardAgentHoverCard>
);

const DashboardAgentHoverCard = ({
  label,
  status,
  icon,
  advisor,
  children,
}: {
  readonly label: string;
  readonly status: string;
  readonly icon: ReactNode;
  readonly advisor: boolean;
  readonly children: ReactNode;
}): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  return <HoverCard open={open} onOpenChange={setOpen} openDelay={100} closeDelay={200}>
    <HoverCardTrigger asChild>
      <button type="button" className="grid min-h-11 w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-sm border-0 bg-transparent p-2 text-left text-foreground hover:bg-[var(--color-menu-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus" aria-label={`${label} — ${status}`} onFocus={() => setOpen(true)}>
        <span className={cn("grid size-6 place-items-center rounded-full bg-accent text-accent-foreground [&_svg]:size-3.5", advisor && "bg-warning-soft text-warning")} aria-hidden="true">{icon}</span>
        <span className="grid min-w-0 gap-px"><span className="truncate font-medium">{label}</span><span className="text-caption text-foreground-secondary">{status}</span></span>
      </button>
    </HoverCardTrigger>
      <HoverCardContent
        className="z-[var(--layer-dialog-popover)] max-h-[min(24rem,calc(100vh_-_2rem))] w-[min(22rem,calc(100vw_-_2rem))] overflow-auto [&>h3]:m-0 [&>h3]:text-control [&>h4]:mb-0 [&>h4]:mt-3 [&>h4]:text-caption [&>h4]:font-semibold [&>h4]:text-foreground-secondary [&>p]:m-0"
        side="left"
        align="start"
        sideOffset={10}
        collisionPadding={16}
      >
        {children}
      </HoverCardContent>
  </HoverCard>;
};

const SubagentDashboardRow = ({ subagent }: { readonly subagent: ActivityState["subagents"][number] }): React.JSX.Element => (
  <li>
    <DashboardAgentRow label={subagent.goal} status={SUBAGENT_STATUS_LABEL[subagent.status]} icon={<Bot />}>
      <p className="mb-1 text-caption font-semibold uppercase tracking-[0.04em] text-foreground-secondary">Subagent · {SUBAGENT_STATUS_LABEL[subagent.status]}</p>
      <h3>{subagent.goal}</h3>
      {subagent.result === undefined ? null : <><h4>Final result</h4><MarkdownMessage>{subagent.result}</MarkdownMessage></>}
    </DashboardAgentRow>
  </li>
);

const AdvisorDashboardRow = ({ notes }: { readonly notes: ActivityState["advisorNotes"] }): React.JSX.Element => (
  <li>
    <DashboardAgentRow label="Advisor" status={`${String(notes.length)} ${notes.length === 1 ? "note" : "notes"}`} icon={<Lightbulb />} advisor>
      <p className="mb-1 text-caption font-semibold uppercase tracking-[0.04em] text-foreground-secondary">Advisor · {String(notes.length)} {notes.length === 1 ? "note" : "notes"}</p>
      <h3>Advisor notes</h3>
      <ol className="mt-3 grid list-none gap-2 p-0">{notes.map(note => <li key={note.order} className={cn("border-l-2 border-accent-foreground py-1 pl-2", note.severity === "concern" && "border-warning", note.severity === "blocker" && "border-destructive")}>
        <span className={cn("mb-0.5 block text-caption font-bold uppercase text-foreground-secondary", note.severity === "concern" && "text-warning", note.severity === "blocker" && "text-destructive")}>{note.severity}</span><p className="text-caption text-foreground-secondary [overflow-wrap:anywhere]">{note.text}</p>
      </li>)}</ol>
    </DashboardAgentRow>
  </li>
);

export const ActivityDashboard = ({ activity }: { readonly activity: ActivityState }): React.JSX.Element => {
  if (activity.todos.length === 0 && activity.subagents.length === 0 && activity.advisorNotes.length === 0 && !activity.todoLoading) return <></>;
  const completed = activity.todos.filter(todo => todo.status === "completed").length;
  return (
    <div data-glass-surface="panel" className="pointer-events-auto grid max-h-[calc(100vh_-_var(--titlebar-height)_-_var(--space-6))] w-full gap-4 self-start overflow-auto rounded-xl border border-border bg-popover p-4 shadow-popover backdrop-blur-popover" role="region" aria-label="Activity Dashboard">
      <header className="flex items-center justify-between gap-2"><h2 className="m-0 text-heading">Activity Dashboard</h2></header>
      {activity.advisorNotes.length > 0 ? <section className="activity-dashboard-section min-w-0" aria-label="Advisor">
        <ol className="m-0 grid list-none content-start gap-0 p-0 [&>li]:block [&>li]:p-0"><AdvisorDashboardRow notes={activity.advisorNotes} /></ol>
      </section> : null}
      {activity.todoLoading || activity.todos.length > 0 ? <section className="activity-dashboard-section min-w-0" aria-labelledby="todo-heading">
        <header className="flex items-baseline justify-between gap-2 py-2 [&>span]:text-caption [&>span]:text-foreground-secondary"><h3 className="m-0 text-control" id="todo-heading">Todos</h3>{activity.todoLoading
          ? <span role="status">Updating todos…</span>
          : <span>{completed} of {activity.todos.length} complete</span>}</header>
        <ol className="mt-2 grid max-h-[min(12rem,24vh)] list-none content-start gap-2 overflow-auto p-0">{activity.todos.map(todo => <li key={todo.id} className={cn("grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 border-b border-border py-2 text-control last:border-b-0", todo.status === "cancelled" && "text-foreground-tertiary")}>
          <span className={cn("font-bold", todo.status === "completed" && "text-success", todo.status === "in_progress" && "text-primary")} aria-hidden="true">{TODO_STATUS_ICON[todo.status]}</span>
          <span className="[overflow-wrap:anywhere]">{todo.content}</span><span className="whitespace-nowrap text-caption text-foreground-secondary">{TODO_STATUS_LABEL[todo.status]}</span>
        </li>)}</ol>
      </section> : null}
      {activity.subagents.length > 0 ? <section className="activity-dashboard-section min-w-0" aria-labelledby="subagents-heading">
        <header className="flex items-baseline justify-between gap-2 py-2 [&>span]:text-caption [&>span]:text-foreground-secondary"><h3 className="m-0 text-control" id="subagents-heading">Subagents</h3><span>{String(activity.subagents.length)}</span></header>
        <ol className="m-0 grid list-none content-start gap-0 p-0 [&>li]:block [&>li]:p-0">
          {activity.subagents.map(subagent => <SubagentDashboardRow key={subagent.index} subagent={subagent} />)}
        </ol>
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
  <details className="group/worked mx-auto mb-6 w-full max-w-content">
    <summary className="flex cursor-pointer list-none items-center justify-between border-b border-border pb-3 text-control text-foreground-secondary"><span>{formatWorkedDuration(durationMs)}</span><span className="text-[1.75rem] leading-none transition-transform duration-fast group-open/worked:rotate-90" aria-hidden="true">›</span></summary>
    <div className="pt-4"><ActivityRows entries={activities} /></div>
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
    <div className="transcript-scroll-indicator pointer-events-none absolute left-[var(--transcript-indicator-left)] top-1/2 z-[1] grid h-[min(var(--transcript-indicator-max-height),42vh,calc(var(--transcript-indicator-dash-count)*var(--space-5)))] w-[var(--transcript-indicator-width)] -translate-y-1/2 auto-rows-fr items-center" aria-hidden="true" style={{ "--transcript-indicator-dash-count": dashCount } as CSSProperties}>
      {dashIndexes.map(index => <span className={cn("h-[3px] w-full bg-[var(--color-transcript-dash-muted)] transition-colors duration-fast", activeDashes.includes(index) && "active bg-[var(--color-transcript-dash-active)]")} key={index} />)}
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
    <div className="relative col-start-1 row-start-1 size-full min-h-0">
      <OverlayScrollbarsComponent
        className="transcript size-full"
        options={transcriptScrollOptions}
        events={{ initialized: initializeTranscriptScroll, updated: handleTranscriptUpdated, scroll: handleTranscriptScroll }}
      >
        <div className={cn("transcript-content min-h-full pb-[var(--transcript-bottom-inset)] pl-[var(--transcript-content-left-base)] pr-8 pt-[var(--transcript-top-inset)] transition-[padding-inline] duration-standard ease-standard", empty && "grid place-items-center")} aria-live="polite">
          {empty && snapshot.phase === "ready"
            ? <EmptyState className="max-w-[26rem]" icon={<Bot />} title="What are we building?" description="Ask Railgun to inspect, explain, or change your project." />
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
            return <article className={cn("message group/message mx-auto mb-6 w-full max-w-content", message.role, message.status === "failed" && "border-l-2 border-destructive pl-3 text-destructive", message.role === "user" && "[&>p]:ml-auto [&>p]:w-fit [&>p]:max-w-[85%] [&>p]:rounded-[var(--radius-lg)_var(--radius-lg)_var(--radius-xs)_var(--radius-lg)] [&>p]:bg-surface-muted [&>p]:px-4 [&>p]:py-2.5", "[&>p]:m-0 [&>p]:whitespace-pre-wrap [&>p]:leading-[1.58] [&>p]:[overflow-wrap:anywhere]")} key={message.id} data-status={message.status}>
              {message.role === "assistant" && message.status !== "streaming"
                ? <MarkdownMessage>{message.text}</MarkdownMessage>
                : <p>{message.text}</p>}
              {message.status === "stopped" ? <span className="mt-2 inline-block text-caption text-foreground-tertiary">Stopped</span> : null}
              {canBranch && onBranch !== undefined && message.branchable && message.messageId !== undefined && entries.some(candidate => candidate.kind === "message" && candidate.order > entry.order) ? <Button
                type="button"
                className="mt-2 flex text-foreground-secondary opacity-0 transition-opacity duration-fast group-hover/message:opacity-100 focus-visible:opacity-100"
                size="sm"
                variant="ghost"
                onClick={() => onBranch(message.messageId!)}
              ><GitBranch aria-hidden="true" />Branch from this message</Button> : null}
            </article>;
          })}
          {state.failedRun === undefined ? null : (
            <div className="mx-auto mb-5 flex w-full max-w-content items-center justify-between gap-3 rounded-sm border border-destructive/45 p-3 text-control text-destructive" role="alert">
              <span>{state.failedRun.error}</span>
              {snapshot.phase === "ready"
                ? <Button type="button" size="sm" variant="secondary" onClick={() => void controller.retry()}>Retry</Button>
                : <Button type="button" size="sm" variant="secondary" onClick={() => void onRestart()}>Restart backend</Button>}
            </div>
          )}
          {shouldShowThinking(state)
            ? <div className="mx-auto flex w-full max-w-content items-center gap-1 text-xs text-foreground-secondary"><i className="size-1.5 animate-bounce rounded-full bg-success motion-reduce:animate-none" /><i className="size-1.5 animate-bounce rounded-full bg-success [animation-delay:150ms] motion-reduce:animate-none" /><i className="size-1.5 animate-bounce rounded-full bg-success [animation-delay:300ms] motion-reduce:animate-none" /><span className="ml-1">Railgun is thinking</span></div>
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
  readonly onHeightChange?: (height: number) => void;
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
    <section className="rounded-md border border-warning bg-surface p-3" aria-label="Shell command approval" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); decline(); }
    }}>
      <div><p className="mb-1 mt-0 text-caption font-bold uppercase tracking-[0.07em] text-warning">Approval needed</p><h2 className="m-0 text-body font-semibold">Allow this shell command?</h2></div>
      <pre className="my-3 max-h-32 overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-surface-muted px-3 py-2 [overflow-wrap:anywhere]" aria-label="Command preview">{prompt.command}</pre>
      {prompt.error === undefined ? null : <p className="mb-0 mt-2 text-caption text-destructive" role="alert">{prompt.error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button ref={approvalControl} type="button" variant="secondary" disabled={prompt.submitting} onClick={() => void onApproval(prompt.id, false)}>Deny</Button>
        <Button type="button" disabled={prompt.submitting} onClick={() => void onApproval(prompt.id, true)}>{prompt.submitting ? "Submitting…" : "Allow"}</Button>
      </div>
    </section>
  ) : (
    <section className="rounded-md border border-warning bg-surface p-3" aria-label="Clarification request" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); decline(); }
    }}>
      <div><p className="mb-1 mt-0 text-caption font-bold uppercase tracking-[0.07em] text-warning">Clarification needed</p><h2 className="m-0 text-body font-semibold">{prompt.question}</h2></div>
      {choices === undefined ? (
        <form onSubmit={event => { event.preventDefault(); if (prompt.answer.trim() !== "") void onAnswer(prompt.id, prompt.answer); }}>
          <label className="mb-1 mt-3 block text-caption text-foreground-secondary" htmlFor={`clarification-${prompt.id}`}>Your answer</label>
          <Input
            ref={firstControl}
            id={`clarification-${prompt.id}`}
            value={prompt.answer}
            maxLength={100_000}
            disabled={prompt.submitting}
            onChange={event => onSelectAnswer(prompt.id, event.target.value)}
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="secondary" disabled={prompt.submitting} onClick={decline}>Decline</Button>
            <Button type="submit" disabled={prompt.submitting || prompt.answer.trim() === ""}>{prompt.submitting ? "Submitting…" : "Submit"}</Button>
          </div>
        </form>
      ) : (
        <div role="radiogroup" aria-label="Clarification choices" className="mt-3 grid gap-2">
          {choices.map((choice, index) => (
            <Button
              type="button"
              role="radio"
              aria-checked={prompt.answer === choice}
              className="w-full justify-start text-left aria-checked:border-focus aria-checked:bg-surface-control-active aria-checked:shadow-focus"
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
      {prompt.error === undefined ? null : <p className="mb-0 mt-2 text-caption text-destructive" role="alert">{prompt.error}</p>}
    </section>
  );
};

const InteractionPrompts = ({ controller }: { readonly controller: ChatController }): React.JSX.Element => (
  <div className="mb-2 grid gap-2" aria-label="Pending agent prompts">
    {controller.state.interactions.map(prompt => <InteractionPromptCard
      key={prompt.id}
      prompt={prompt}
      onAnswer={controller.respondToClarification}
      onApproval={controller.respondToApproval}
      onSelectAnswer={controller.setInteractionAnswer}
    />)}
  </div>
);

export const Composer = ({ controller, available, controls, onHeightChange }: ComposerProps): React.JSX.Element => {
  const { state, draft } = controller;
  const interactionsOpen = state.interactions.length > 0;
  const composerRef = useRef<HTMLDivElement>(null);
  const reportComposerHeight = useCallback((entry?: ResizeObserverEntry): void => {
    const composer = composerRef.current;
    if (composer === null || onHeightChange === undefined) return;
    const borderBoxHeight = entry?.borderBoxSize[0]?.blockSize;
    const height = Math.ceil(borderBoxHeight ?? composer.getBoundingClientRect().height);
    if (height > 0) onHeightChange(height);
  }, [onHeightChange]);
  useLayoutEffect(() => reportComposerHeight());
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (composer === null || onHeightChange === undefined) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => reportComposerHeight(entries[0]));
    observer.observe(composer, { box: "border-box" });
    return () => observer.disconnect();
  }, [onHeightChange, reportComposerHeight]);
  return (
    <div ref={composerRef} data-composer-root className="col-start-1 row-start-1 h-fit z-[2] self-end px-7 pb-2 pt-3 transition-[padding] duration-standard ease-standard">
      <div className="mx-auto w-full max-w-content">
        <InteractionPrompts controller={controller} />
        {state.queue.length === 0 ? null : (
          <section className="mb-2 rounded-sm border border-border bg-surface px-3 py-2" aria-label="Queued messages">
            <h2 className="mb-1 mt-0 text-caption uppercase tracking-[0.07em] text-foreground-secondary">Queued</h2>
            <ol className="m-0 grid list-none gap-1 p-0">{state.queue.map(item => <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-control" key={item.id}><span className="text-caption text-foreground-tertiary">{item.kind === "steering" ? "Steering" : "Follow-up"}</span><p className="m-0 truncate">{item.text}</p></li>)}</ol>
          </section>
        )}
        <div data-glass-surface="composer" className="relative z-[1] flex flex-col items-stretch rounded-lg border border-border bg-popover p-3 shadow-control backdrop-blur-popover focus-within:border-focus focus-within:shadow-focus">
          <Textarea
            aria-label="Message Railgun"
            rows={1}
            className="min-h-[calc(1lh+var(--space-4)+2px)] max-h-[calc(10lh+var(--space-4)+2px)] resize-none overflow-y-auto [field-sizing:content]"
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
          <div className="mt-3 flex items-center gap-2">
            {controls === undefined ? null : <div className="min-w-0 flex-1">{controls}</div>}
            {state.running ? (
              <Button variant="destructive" size="icon" className="shrink-0" aria-label="Stop" disabled={state.stopping} onClick={() => void controller.stop()}><Square aria-hidden="true" /></Button>
            ) : (
              <Button size="icon" className="shrink-0" aria-label="Send" disabled={draft.trim() === "" || !available} onClick={() => void controller.sendInitial()}><Send className="-translate-x-px translate-y-px" aria-hidden="true" /></Button>
            )}
          </div>
        </div>
        {state.submissionError === undefined ? null : <p className="mb-0 mt-2 text-caption text-destructive" role="alert">{state.submissionError}</p>}
        <p className="relative z-[2] mx-auto -mt-px w-fit rounded-b-sm border border-t-0 border-border bg-surface px-4 pb-[0.3125rem] pt-1 text-center text-[0.625rem] text-foreground-tertiary shadow-control">{interactionsOpen ? "Answer the pending prompt to continue" : state.running ? "Enter steers · Tab queues follow-up · Shift+Enter adds a line" : "Enter sends · Shift+Enter adds a line"}</p>
      </div>
    </div>
  );
};
