import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { PanelRightOpen, Search, SlidersHorizontal, SquarePen } from "lucide-react";
import { MockScenarioIdSchema } from "../shared/schemas";
import type { AppCommand, BackendSnapshot, MockScenario, RestoredTranscriptMessage, SessionSnapshot, SessionSummary } from "../shared/types";
import { Button, InsetIconButton } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Checkbox } from "./components/ui/checkbox";
import { ConfirmDialog } from "./components/ui/confirm-dialog";
import { InlineAlert } from "./components/ui/feedback";
import { ErrorState, LoadingState } from "./components/ui/state";
import { CommandPalette } from "./commands/CommandPalette";
import { commandFromKeyboardEvent, createCommandRegistry } from "./commands/commandRegistry";
import { ShellLayout } from "./shell/ShellLayout";
import { AppSidebar } from "./shell/AppSidebar";
import { ActivityDashboard, Composer, Transcript, useChatController } from "./chat/Chat";
import { ChatToolbarControls } from "./chat/ChatControls";
import { RETRYABLE_PHASES } from "./backendStatus";
import { errorMessage } from "./lib/utils";
import { readStoredArea, writeStoredArea } from "./routeStorage";
import type { AppArea } from "./routeStorage";
import { TaskPalette } from "./tasks/TaskPalette";
import { FileBrowser } from "./files/FileBrowser";
import { SettingsPage } from "./settings/SettingsPage";
import { AutomationPage } from "./automation/AutomationPage";

const COMPLETED_SESSION_INDICATOR_MS = 5_000;

export const App = (): React.JSX.Element => {
  const [snapshot, setSnapshot] = useState<BackendSnapshot>();
  const [scenarios, setScenarios] = useState<readonly MockScenario[]>([]);
  const [area, setArea] = useState<AppArea>(() => readStoredArea(window.localStorage));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [controlsResetKey, setControlsResetKey] = useState(0);
  const [composerHeight, setComposerHeight] = useState<number>();
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string>();
  const [taskPaletteOpen, setTaskPaletteOpen] = useState(false);
  const [activeSession, setActiveSession] = useState<SessionSnapshot>();
  const [completedSessionId, setCompletedSessionId] = useState<string>();
  const [sessionOperation, setSessionOperation] = useState(false);
  const [activityPaneVisible, setActivityPaneVisible] = useState(true);
  const [filesPaneVisible, setFilesPaneVisible] = useState(false);
  const [branchMessageId, setBranchMessageId] = useState<number>();
  const [branchSummarize, setBranchSummarize] = useState(false);
  const [branchSubmitting, setBranchSubmitting] = useState(false);
  const [branchError, setBranchError] = useState<string>();
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [pendingSettingsExit, setPendingSettingsExit] = useState<(() => void) | undefined>();
  const paletteRestoreFocus = useRef<HTMLElement | null>(null);
  const taskPaletteRestoreFocus = useRef<HTMLElement | null>(null);
  const activeSessionId = useRef<string | undefined>(undefined);
  const runningSessionId = useRef<string | undefined>(undefined);
  const appCommandHandler = useRef<(command: AppCommand) => void>(() => undefined);
  const chat = useChatController(snapshot);
  const running = chat.state.running;
  const hasActivity = chat.state.activity.todos.length > 0
    || chat.state.activity.subagents.length > 0
    || chat.state.activity.advisorNotes.length > 0
    || chat.state.activity.todoLoading;
  const sessionActivity = running
    ? activeSession === undefined ? undefined : { sessionId: activeSession.id, state: "working" as const }
    : completedSessionId === undefined ? undefined : { sessionId: completedSessionId, state: "completed" as const };
  const sidebarSessionState = {
    ...(sessionsError === undefined ? {} : { sessionsError }),
    ...(activeSession === undefined ? {} : { activeSessionId: activeSession.id }),
    ...(sessionActivity === undefined ? {} : { sessionActivity }),
  };

  useEffect(() => {
    if (running) {
      setCompletedSessionId(undefined);
      runningSessionId.current = activeSession?.id;
      return;
    }
    const justCompletedSessionId = runningSessionId.current;
    runningSessionId.current = undefined;
    if (justCompletedSessionId !== undefined) setCompletedSessionId(justCompletedSessionId);
  }, [activeSession?.id, running]);

  useEffect(() => {
    if (completedSessionId === undefined) return;
    const timeout = window.setTimeout(() => {
      setCompletedSessionId(sessionId => sessionId === completedSessionId ? undefined : sessionId);
    }, COMPLETED_SESSION_INDICATOR_MS);
    return () => window.clearTimeout(timeout);
  }, [completedSessionId]);
  const selectArea = (next: AppArea): void => {
    setArea(next);
    try { writeStoredArea(window.localStorage, next); }
    catch { /* Navigation remains usable when storage is unavailable. */ }
  };
  const guardSettingsExit = (action: () => void): void => {
    if (area === "settings" && settingsDirty) setPendingSettingsExit(() => action);
    else action();
  };
  const requestArea = (next: AppArea): void => {
    if (next !== area) guardSettingsExit(() => selectArea(next));
  };

  const loadSessions = async (): Promise<void> => {
    setSessionsLoading(true);
    setSessionsError(undefined);
    try { setSessions(await window.railgunDesktop.listSessions()); }
    catch (error) { setSessionsError(errorMessage(error, "Unable to load sessions")); }
    finally { setSessionsLoading(false); }
  };

  useEffect(() => {
    if (snapshot !== undefined && snapshot.phase !== "ready") setControlsResetKey(key => key + 1);
  }, [snapshot?.phase]);

  useEffect(() => {
    let active = true;
    void window.railgunDesktop.getBackendSnapshot().then(
      (next) => { if (active) setSnapshot(next); },
      (error: unknown) => { if (active) setBootstrapError(errorMessage(error, "Unable to connect to Railgun")); },
    );
    void window.railgunDesktop.listMockScenarios().then(
      (next) => { if (active) setScenarios(next); },
      (error: unknown) => { if (active) setOperationError(errorMessage(error, "Unable to load diagnostics")); },
    );
    const unsubscribeSnapshot = window.railgunDesktop.onBackendSnapshot(setSnapshot);
    const unsubscribeSession = window.railgunDesktop.onSessionSnapshot((next) => {
      const sameSession = activeSessionId.current === undefined || activeSessionId.current === next.id;
      activeSessionId.current = next.id;
      setActiveSession(next);
      if (sameSession) chat.refresh(next);
      else chat.hydrate(next);
      setControlsResetKey(key => key + 1);
      void loadSessions();
    });
    const unsubscribeSessionList = window.railgunDesktop.onSessionList((next) => {
      setSessions(next);
      setSessionsError(undefined);
      setSessionsLoading(false);
    });
    return () => { active = false; unsubscribeSnapshot(); unsubscribeSession(); unsubscribeSessionList(); };
  }, []);

  useEffect(() => {
    if (snapshot?.phase === "ready") void loadSessions();
    else if (snapshot !== undefined) { setSessions([]); setSessionsLoading(false); }
  }, [snapshot?.phase]);

  useEffect(() => window.railgunDesktop.onAppCommand((command) => appCommandHandler.current(command)), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = commandFromKeyboardEvent(event);
      if (command !== undefined) {
        event.preventDefault();
        appCommandHandler.current(command);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const activateSessionSnapshot = (nextSession: SessionSnapshot): void => {
    activeSessionId.current = nextSession.id;
    setActiveSession(nextSession);
    chat.hydrate(nextSession);
    setControlsResetKey(key => key + 1);
    selectArea("chat");
  };

  const startNewTask = async (): Promise<void> => {
    if (sessionOperation) return;
    setSessionOperation(true);
    if (running && !await chat.stopAndWait()) { setSessionOperation(false); return; }
    try {
      setOperationError(undefined);
      activateSessionSnapshot(await window.railgunDesktop.startNewChat());
      await loadSessions();
    } catch (error) {
      setOperationError(errorMessage(error, "Unable to start a new task"));
    } finally { setSessionOperation(false); }
  };
  const requestNewTask = (): void => guardSettingsExit(() => { void startNewTask(); });

  const resumeSession = async (sessionId: string): Promise<void> => {
    if (sessionOperation) return;
    if (sessionId === activeSession?.id) { selectArea("chat"); return; }
    setSessionOperation(true);
    if (running && !await chat.stopAndWait()) { setSessionOperation(false); return; }
    try {
      setOperationError(undefined);
      activateSessionSnapshot(await window.railgunDesktop.resumeSession(sessionId));
      await loadSessions();
    } catch (error) {
      setOperationError(errorMessage(error, "Unable to resume the session"));
    } finally { setSessionOperation(false); }
  };

  const hydrateMutation = async (operation: () => Promise<SessionSnapshot>): Promise<void> => {
    activateSessionSnapshot(await operation());
    await loadSessions();
  };

  const branchSession = async (): Promise<void> => {
    if (branchMessageId === undefined || branchSubmitting) return;
    setBranchSubmitting(true);
    setBranchError(undefined);
    try {
      await hydrateMutation(() => window.railgunDesktop.branchSession(branchMessageId, branchSummarize));
      setBranchMessageId(undefined);
      setBranchSummarize(false);
    } catch (error) {
      setBranchError(errorMessage(error, "Unable to branch the task"));
    } finally { setBranchSubmitting(false); }
  };

  const forkSession = async (sessionId: string): Promise<void> => {
    if (sessionOperation) return;
    setSessionOperation(true);
    if (running && !await chat.stopAndWait()) { setSessionOperation(false); return; }
    try {
      setOperationError(undefined);
      await hydrateMutation(() => window.railgunDesktop.forkSession(sessionId));
    } catch (error) {
      setOperationError(errorMessage(error, "Unable to fork the task"));
    } finally { setSessionOperation(false); }
  };

  const archiveSession = async (sessionId: string): Promise<void> => {
    if (sessionOperation || running) return;
    setSessionOperation(true);
    try {
      setOperationError(undefined);
      const next = await window.railgunDesktop.archiveSession(sessionId);
      if (activeSession?.id === sessionId) activateSessionSnapshot(next);
      await loadSessions();
    } catch (error) {
      setOperationError(errorMessage(error, "Unable to archive the task"));
    } finally { setSessionOperation(false); }
  };

  const openSessionContextMenu = useCallback((sessionId: string): void => {
    if (sessionOperation) return;
    void (async () => {
      try {
        const action = await window.railgunDesktop.showSessionContextMenu(sessionId);
        if (action === "fork") await forkSession(sessionId);
      } catch (error) {
        setOperationError(errorMessage(error, "Unable to open session menu"));
      }
    })();
  }, [forkSession, sessionOperation]);

  const restartBackend = async (): Promise<void> => {
    try {
      setOperationError(undefined);
      setSnapshot(await window.railgunDesktop.restartBackend());
    } catch (error) {
      setOperationError(errorMessage(error, "Unable to restart the backend"));
    }
  };

  const selectMockScenario = async (value: string): Promise<void> => {
    try {
      setOperationError(undefined);
      setSnapshot(await window.railgunDesktop.selectMockScenario(MockScenarioIdSchema.parse(value)));
    } catch (error) {
      setOperationError(errorMessage(error, "Unable to restart the mock backend"));
    }
  };

  const openCommandPalette = (): void => {
    paletteRestoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPaletteOpen(true);
  };
  const openTaskPalette = (): void => {
    taskPaletteRestoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTaskPaletteOpen(true);
  };
  const commands = createCommandRegistry({
    newChat: requestNewTask,
    showChat: () => requestArea("chat"),
    showSettings: () => requestArea("settings"),
    toggleSidebar: () => setSidebarCollapsed((collapsed) => !collapsed),
    retryBackend: () => { void restartBackend(); },
    stopResponse: () => { void chat.stop(); },
    canRetryBackend: snapshot !== undefined && RETRYABLE_PHASES.has(snapshot.phase),
    responseRunning: running,
  });
  appCommandHandler.current = (command) => {
    if (command === "command-palette") {
      openCommandPalette();
      return;
    }
    commands.find((candidate) => candidate.id === command && candidate.enabled)?.execute();
  };

  if (snapshot === undefined) return bootstrapError === undefined ? (
    <main className="grid h-full place-content-center justify-items-center p-8">
      <LoadingState title="Connecting to Railgun…" description="Starting the secure desktop connection." />
    </main>
  ) : (
    <main className="grid h-full place-content-center justify-items-center p-8">
      <ErrorState title="Unable to connect" description={bootstrapError} />
    </main>
  );

  if (area === "settings") return <>
    <SettingsPage
      backend={snapshot}
      agentRunning={running}
      scenarios={scenarios}
      onBack={() => { setSettingsDirty(false); selectArea("chat"); }}
      onDirtyChange={setSettingsDirty}
      onSaved={() => setControlsResetKey(key => key + 1)}
      onRetryBackend={restartBackend}
      onSelectScenario={selectMockScenario}
      onSessionsChanged={loadSessions}
    />
    <ConfirmDialog
      open={pendingSettingsExit !== undefined}
      title="Discard unsaved changes?"
      description="Your instruction edits have not been saved."
      confirmLabel="Discard Changes"
      destructive
      onOpenChange={open => { if (!open) setPendingSettingsExit(undefined); }}
      onConfirm={() => {
        const action = pendingSettingsExit;
        setPendingSettingsExit(undefined);
        setSettingsDirty(false);
        action?.();
      }}
    />
  </>;
  const sidebar = <AppSidebar
    area={area}
    phase={snapshot.phase}
    sessions={sessions}
    sessionsLoading={sessionsLoading}
    {...sidebarSessionState}
    busy={sessionOperation}
    running={running}
    onNewTask={() => void startNewTask()}
    onScheduled={() => selectArea("automation")}
    onSettings={() => selectArea("settings")}
    onRetrySessions={() => void loadSessions()}
    onResumeSession={id => void resumeSession(id)}
    onOpenSessionMenu={openSessionContextMenu}
    onArchiveSession={id => void archiveSession(id)}
  />;
  const activityPaneToggle = <Button
      type="button"
      variant="ghost"
      size="icon"
      className="aria-pressed:bg-surface-control-active aria-pressed:text-foreground [-webkit-app-region:no-drag]"
      aria-label={hasActivity && activityPaneVisible ? "Hide Activity Dashboard" : "Show Activity Dashboard"}
      aria-pressed={hasActivity && activityPaneVisible}
      disabled={!hasActivity}
      title={hasActivity && activityPaneVisible ? "Hide Activity Dashboard" : "Show Activity Dashboard"}
      onClick={() => setActivityPaneVisible(visible => !visible)}
    ><SlidersHorizontal aria-hidden="true" /></Button>;
  const filesPaneToggle = <Button
      type="button"
      variant="ghost"
      size="icon"
      className="[-webkit-app-region:no-drag]"
      aria-label="Open Files"
      aria-pressed="false"
      title="Open Files"
      onClick={() => setFilesPaneVisible(true)}
    ><PanelRightOpen aria-hidden="true" /></Button>;
  const firstUserMessage = activeSession?.transcript.find((entry): entry is RestoredTranscriptMessage => entry.role === "user");
  const scheduledWarning = activeSession?.delivery?.status === "incomplete"
    ? { variant: "warning" as const, title: "Scheduled task incomplete", detail: "The scheduled run settled without completing all requested work." }
    : activeSession?.delivery?.status === "failed"
      ? { variant: "destructive" as const, title: "Scheduled task failed", detail: "The scheduled run failed. You can continue this task with a follow-up." }
      : undefined;
  const toolbarActions = <div className="content-toolbar-actions pointer-events-auto absolute right-[calc(var(--toolbar-surface-right)+var(--space-7))] top-[var(--titlebar-control-center-y)] z-[var(--layer-titlebar-action)] flex -translate-y-1/2 items-center gap-2 [-webkit-app-region:no-drag]">
    <div className="text-caption text-foreground-secondary [&_details]:relative [&_details_span]:absolute [&_details_span]:right-0 [&_details_span]:top-[calc(100%_+_var(--space-2))] [&_details_span]:w-64 [&_details_span]:rounded-sm [&_details_span]:border [&_details_span]:border-border [&_details_span]:bg-popover [&_details_span]:p-2 [&_details_span]:text-foreground [&_details_span]:shadow-popover [&_summary]:cursor-default">{running || activeSession?.checkpoint.state === "pending" ? "Saving…" : activeSession?.checkpoint.state === "saved" ? "Saved" : activeSession?.checkpoint.state === "error" ? <details><summary>Save failed</summary><span>{activeSession.checkpoint.detail}</span></details> : "Not saved"}</div>
    {filesPaneVisible
      ? <div className="right-pane-controls single-pane-control flex size-[var(--titlebar-control-height)] items-center justify-center overflow-hidden rounded-full border border-border bg-surface-control [-webkit-app-region:no-drag] [&>button]:size-full">{activityPaneToggle}</div>
      : <div className="right-pane-controls flex h-[var(--titlebar-control-height)] items-center overflow-hidden rounded-full border border-border bg-surface-control [-webkit-app-region:no-drag]">{activityPaneToggle}<span className="h-[calc(100%_-_var(--space-4))] w-px bg-border-strong" aria-hidden="true" />{filesPaneToggle}</div>}
  </div>;
  const chatContentStyle = composerHeight === undefined ? undefined : {
    "--transcript-bottom-inset": `calc(${String(composerHeight)}px + var(--space-5))`,
  } as CSSProperties;
  const chatContent = <section className="relative grid size-full min-w-0 overflow-hidden bg-transparent" style={chatContentStyle}>
          <header className="content-toolbar relative z-[var(--layer-titlebar-control)] col-start-1 row-start-1 flex w-full self-start bg-transparent pb-2 pr-[var(--titlebar-actions-safe-width)] pt-[calc(var(--titlebar-control-center-y)_-_0.875rem)]">
            <div className="ml-[var(--toolbar-content-left)] min-w-0 flex-1 transition-[margin-left] duration-standard ease-standard"><h1 className="m-0 max-w-full truncate text-[0.9375rem] font-semibold tracking-[-0.01em]">{activeSession?.delivery?.title ?? firstUserMessage?.text.slice(0, 500) ?? "New Task"}</h1><p className="mb-0 mt-0.5 text-caption text-foreground-secondary">{activeSession?.model ?? (snapshot.mode === "mock" ? "Mock backend" : "Devin provider")}</p></div>
          </header>
          {operationError === undefined && scheduledWarning === undefined ? null
            : <div className="z-[3] col-start-1 row-start-1 mx-[max(var(--space-7),calc((100%_-_var(--container-content))/2))] mt-[var(--transcript-top-inset)] grid gap-2 self-start">
              {operationError === undefined ? null : <InlineAlert variant="destructive">{operationError}</InlineAlert>}
              {scheduledWarning === undefined ? null : <InlineAlert variant={scheduledWarning.variant} title={scheduledWarning.title}>{scheduledWarning.detail}</InlineAlert>}
            </div>}
          <Transcript
            controller={chat}
            snapshot={snapshot}
            onRestart={restartBackend}
            canBranch={snapshot.phase === "ready" && !running && !sessionOperation && activeSession?.checkpoint.state === "saved"}
            onBranch={messageId => { setBranchMessageId(messageId); setBranchSummarize(false); setBranchError(undefined); }}
          />
          <Composer
            controller={chat}
            available={snapshot.phase === "ready"}
            controls={<ChatToolbarControls running={running} available={snapshot.phase === "ready"} resetKey={controlsResetKey} />}
            onHeightChange={setComposerHeight}
          />
        </section>;
  const content = area === "automation"
    ? <AutomationPage backendPhase={snapshot.phase} />
    : chatContent;

  return (
    <>
      <ShellLayout
        sidebar={sidebar}
        sidebarAction={<InsetIconButton type="button" className="task-search-button absolute left-[calc(var(--sidebar-gutter)_+_var(--sidebar-width)_-_var(--space-2)_-_var(--titlebar-control-height))] top-[var(--titlebar-control-center-y)] z-[var(--layer-titlebar-control)] -translate-y-1/2 rounded-full [-webkit-app-region:no-drag]" aria-label="Search tasks" disabled={sessionOperation} onClick={openTaskPalette}><Search aria-hidden="true" /></InsetIconButton>}
        collapsedSidebarAction={<Button type="button" variant="ghost" size="icon" className="[-webkit-app-region:no-drag]" aria-label="New Task" disabled={sessionOperation} onClick={() => void startNewTask()}><SquarePen aria-hidden="true" /></Button>}
        main={content}
        mainAction={area === "chat" ? toolbarActions : undefined}
        inspector={area === "chat" && hasActivity ? <ActivityDashboard activity={chat.state.activity} /> : undefined}
        inspectorLabel="Activity Dashboard"
        inspectorVisible={area === "chat" && activityPaneVisible}
        workspace={area === "chat" ? <FileBrowser onCollapse={() => setFilesPaneVisible(false)} /> : undefined}
        workspaceVisible={area === "chat" && filesPaneVisible}
        sidebarVisible={!sidebarCollapsed}
        onSidebarVisibilityChange={(visible) => setSidebarCollapsed(!visible)}
      />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        restoreFocusTo={paletteRestoreFocus.current}
        onOpenChange={setPaletteOpen}
      />
      <TaskPalette
        open={taskPaletteOpen}
        sessions={sessions}
        activeSessionId={activeSession?.id}
        loading={sessionsLoading}
        error={sessionsError}
        disabled={sessionOperation}
        restoreFocusTo={taskPaletteRestoreFocus.current}
        onOpenChange={setTaskPaletteOpen}
        onRetry={() => { void loadSessions(); }}
        onSelect={(sessionId) => { void resumeSession(sessionId); }}
      />
      <Dialog open={branchMessageId !== undefined} onOpenChange={open => { if (!open && !branchSubmitting) { setBranchMessageId(undefined); setBranchError(undefined); } }}>
        <DialogContent className="w-[min(30rem,calc(100vw_-_2rem))]">
          <DialogHeader><DialogTitle>Branch from this message?</DialogTitle><DialogDescription>This rewinds the active task to this message. Later messages remain preserved in the abandoned branch.</DialogDescription></DialogHeader>
          <label className="mt-5 flex items-center gap-2 text-body"><Checkbox checked={branchSummarize} disabled={branchSubmitting} onCheckedChange={checked => setBranchSummarize(checked === true)} /> <span>Summarize later messages</span></label>
          {branchError === undefined ? null : <p className="mb-0 mt-3 text-control text-destructive" role="alert">{branchError}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={branchSubmitting} onClick={() => setBranchMessageId(undefined)}>Cancel</Button>
            <Button type="button" variant="secondary" disabled={branchSubmitting} onClick={() => void branchSession()}>{branchSubmitting ? "Branching…" : "Branch"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
