import { Archive, Check, Clock, LoaderCircle, Settings, SquarePen } from "lucide-react";
import { useState } from "react";
import type { BackendPhase, SessionSummary } from "../../shared/types";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { PHASE_COPY } from "../backendStatus";

type SessionActivityState = "working" | "completed";

interface SessionActivity {
  readonly sessionId: string;
  readonly state: SessionActivityState;
}

interface AppSidebarProps {
  readonly area: "chat" | "automation" | "settings";
  readonly phase: BackendPhase;
  readonly sessions: readonly SessionSummary[];
  readonly sessionsLoading: boolean;
  readonly sessionsError?: string;
  readonly activeSessionId?: string;
  readonly sessionActivity?: SessionActivity;
  readonly busy: boolean;
  readonly running: boolean;
  readonly onNewTask: () => void;
  readonly onScheduled: () => void;
  readonly onSettings: () => void;
  readonly onRetrySessions: () => void;
  readonly onResumeSession: (id: string) => void;
  readonly onOpenSessionMenu: (id: string) => void;
  readonly onArchiveSession: (id: string) => void;
}

const sidebarAction = "sidebar-action w-full justify-start gap-2 px-2 text-body font-normal tracking-[-0.01em] text-foreground hover:bg-[var(--material-sidebar-control-hover)]";

const SessionActivityIndicator = ({ state }: { readonly state: SessionActivityState }): React.JSX.Element => state === "working"
  ? <span className="mr-1 flex size-4 shrink-0 items-center justify-center text-primary" role="status" aria-label="Agent working" title="Agent working"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /></span>
  : <span className="mr-1 flex size-4 shrink-0 items-center justify-center text-success" role="img" aria-label="Agent completed" title="Agent completed"><Check className="size-3.5" aria-hidden="true" /></span>;

export const AppSidebar = ({ area, phase, sessions, sessionsLoading, sessionsError, activeSessionId, sessionActivity, busy, running, onNewTask, onScheduled, onSettings, onRetrySessions, onResumeSession, onOpenSessionMenu, onArchiveSession }: AppSidebarProps): React.JSX.Element => {
  const [scrolled, setScrolled] = useState(false);
  return <>
    <div className="sidebar-pinned-top px-3">
      <div className="brand pb-2 pl-2 text-[1.0625rem] font-bold tracking-[-0.02em]"><span>Railgun</span></div>
      <Button className={sidebarAction} variant="ghost" disabled={busy} onClick={onNewTask}><SquarePen aria-hidden="true" />New Task</Button>
    </div>
    <div className={cn("mt-2 h-px w-full shrink-0 bg-border", !scrolled && "invisible")} aria-hidden="true" />
    <div className="sidebar-scroll min-h-0 flex-1 overflow-auto px-3 [scrollbar-color:var(--color-text-tertiary)_transparent] [scrollbar-width:thin]" onScroll={event => setScrolled(event.currentTarget.scrollTop > 0)}>
      <Button variant="ghost" className={cn(sidebarAction, area === "automation" && "bg-accent text-accent-foreground")} aria-current={area === "automation" ? "page" : undefined} onClick={onScheduled}><Clock aria-hidden="true" />Scheduled</Button>
      <section className="flex min-h-0 flex-1 flex-col" aria-label="Tasks">
        <p className="mb-1 mt-4 px-2 text-caption font-semibold tracking-[0.04em] text-foreground-secondary">Tasks</p>
        <div className="min-h-0">
          {sessionsLoading ? <p className="mx-2 my-3 text-caption text-foreground-secondary" role="status">Loading sessions…</p>
            : sessionsError !== undefined ? <div className="mx-2 my-3 text-caption text-foreground-secondary" role="alert"><p>{sessionsError}</p><Button size="sm" variant="ghost" onClick={onRetrySessions}>Retry</Button></div>
              : sessions.length === 0 ? <p className="mx-2 my-3 text-caption text-foreground-secondary">No saved tasks</p>
                : sessions.map(session => <div key={session.id} className={cn("group flex w-full items-center gap-1 rounded-sm text-foreground hover:bg-[var(--material-sidebar-control-hover)] focus-within:bg-[var(--material-sidebar-control-hover)]", activeSessionId === session.id && "bg-accent text-accent-foreground")}>
                  <button type="button" className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden border-0 bg-transparent p-2 text-left text-inherit [&>span]:truncate [&>span]:text-caption [&>span]:text-foreground-secondary [&>strong]:truncate [&>strong]:text-control [&>strong]:font-medium" aria-current={activeSessionId === session.id ? "true" : undefined} disabled={busy} onContextMenu={event => { event.preventDefault(); onOpenSessionMenu(session.id); }} onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); onOpenSessionMenu(session.id); } }} onClick={() => onResumeSession(session.id)}><strong>{session.firstUserPreview || "Untitled chat"}</strong><span>{session.model} · {session.startedAtLocal}</span></button>
                  {sessionActivity?.sessionId === session.id ? <SessionActivityIndicator state={sessionActivity.state} /> : null}
                  <Button type="button" variant="ghost" size="icon" className="mr-1 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" aria-label={`Archive ${session.firstUserPreview || "Untitled chat"}`} title={`Archive ${session.firstUserPreview || "Untitled chat"}`} disabled={busy || running} onClick={event => { event.stopPropagation(); onArchiveSession(session.id); }}><Archive aria-hidden="true" /></Button>
                </div>)}
        </div>
      </section>
    </div>
    <div className="mb-2 h-px w-full shrink-0 bg-border" aria-hidden="true" />
    <div className="sidebar-bottom px-3 pb-3">
      <Button variant="ghost" className={cn(sidebarAction, area === "settings" && "bg-accent text-accent-foreground")} aria-current={area === "settings" ? "page" : undefined} onClick={onSettings}><Settings aria-hidden="true" />Settings</Button>
      <div className="sidebar-footer flex items-center gap-2 px-2 py-1 text-[0.625rem] text-foreground-tertiary"><span className={cn("size-1.5 rounded-full bg-warning", phase === "ready" && "bg-success", (phase === "failed" || phase === "disconnected") && "bg-destructive")} aria-hidden="true" /><span>{PHASE_COPY[phase].title}</span></div>
    </div>
  </>;
};
