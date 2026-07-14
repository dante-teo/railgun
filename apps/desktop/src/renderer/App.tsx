import { useEffect, useRef, useState } from "react";
import { Bot, GitFork, Search, Settings, SlidersHorizontal, SquarePen, TerminalSquare } from "lucide-react";
import { MockScenarioIdSchema } from "../shared/schemas";
import type { AppCommand, BackendSnapshot, MockScenario, SessionSnapshot, SessionSummary } from "../shared/types";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { Card, CardContent, CardHeader } from "./components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { ErrorState, LoadingState } from "./components/ui/state";
import { CommandPalette } from "./commands/CommandPalette";
import { commandFromKeyboardEvent, createCommandRegistry } from "./commands/commandRegistry";
import { ShellLayout } from "./shell/ShellLayout";
import { ActivityInspector, Composer, Transcript, useChatController } from "./chat/Chat";
import { ChatToolbarControls } from "./chat/ChatControls";
import { BackendStatus, PHASE_COPY, RETRYABLE_PHASES } from "./backendStatus";
import { errorMessage } from "./lib/utils";
import { readStoredArea, writeStoredArea } from "./routeStorage";
import type { AppArea } from "./routeStorage";
import { TaskPalette } from "./tasks/TaskPalette";

interface MockPanelProps {
  readonly snapshot: BackendSnapshot;
  readonly scenarios: readonly MockScenario[];
  readonly onSelect: (id: string) => Promise<void>;
}

export const MockPanel = ({ snapshot, scenarios, onSelect }: MockPanelProps): React.JSX.Element => {
  const [selectedId, setSelectedId] = useState(snapshot.scenarioId ?? scenarios[0]?.id ?? "");
  const [restarting, setRestarting] = useState(false);
  useEffect(() => { if (snapshot.scenarioId !== undefined) setSelectedId(snapshot.scenarioId); }, [snapshot.scenarioId]);
  const restart = async (): Promise<void> => {
    if (selectedId.length === 0) return;
    setRestarting(true);
    try { await onSelect(selectedId); } finally { setRestarting(false); }
  };
  return (
    <Card className="mock-panel">
      <CardHeader><p className="eyebrow">Mock diagnostics</p><h2>Backend scenario</h2></CardHeader>
      <CardContent>
        <div className="scenario-controls">
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger aria-label="Mock scenario"><SelectValue placeholder="Choose a scenario" /></SelectTrigger>
            <SelectContent>{scenarios.map((scenario) => <SelectItem value={scenario.id} key={scenario.id}>{scenario.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button type="button" variant="tonal" disabled={restarting || selectedId.length === 0} onClick={() => void restart()}>
            {restarting ? "Restarting…" : "Restart backend"}
          </Button>
        </div>
        <p className="scenario-description">{scenarios.find((scenario) => scenario.id === selectedId)?.description}</p>
        <div className="transport"><h3>Transport log</h3><ol>{snapshot.transportLog.map((entry, index) => (
          <li key={`${String(index)}-${entry.direction}`}><span>{entry.direction}</span><code>{entry.text}</code></li>
        ))}</ol></div>
      </CardContent>
    </Card>
  );
};

export const App = (): React.JSX.Element => {
  const [snapshot, setSnapshot] = useState<BackendSnapshot>();
  const [scenarios, setScenarios] = useState<readonly MockScenario[]>([]);
  const [area, setArea] = useState<AppArea>(() => readStoredArea(window.localStorage));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [controlsResetKey, setControlsResetKey] = useState(0);
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string>();
  const [taskPaletteOpen, setTaskPaletteOpen] = useState(false);
  const [activeSession, setActiveSession] = useState<SessionSnapshot>();
  const [sessionOperation, setSessionOperation] = useState(false);
  const [todoPaneVisible, setTodoPaneVisible] = useState(true);
  const [branchMessageId, setBranchMessageId] = useState<number>();
  const [branchSummarize, setBranchSummarize] = useState(false);
  const [branchSubmitting, setBranchSubmitting] = useState(false);
  const [branchError, setBranchError] = useState<string>();
  const [contextSessionId, setContextSessionId] = useState<string>();
  const paletteRestoreFocus = useRef<HTMLElement | null>(null);
  const taskPaletteRestoreFocus = useRef<HTMLElement | null>(null);
  const appCommandHandler = useRef<(command: AppCommand) => void>(() => undefined);
  const chat = useChatController(snapshot);
  const running = chat.state.running;
  const hasActivity = chat.state.activity.todos.length > 0
    || chat.state.activity.subagents.length > 0
    || chat.state.activity.todoLoading;

  const selectArea = (next: AppArea): void => {
    setArea(next);
    try { writeStoredArea(window.localStorage, next); }
    catch { /* Navigation remains usable when storage is unavailable. */ }
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
      setActiveSession(next);
      chat.hydrate(next);
      setControlsResetKey(key => key + 1);
      void loadSessions();
    });
    return () => { active = false; unsubscribeSnapshot(); unsubscribeSession(); };
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

  const resumeSession = async (sessionId: string): Promise<void> => {
    if (sessionOperation || sessionId === activeSession?.id) return;
    setSessionOperation(true);
    if (running && !await chat.stopAndWait()) { setSessionOperation(false); return; }
    try {
      setOperationError(undefined);
      activateSessionSnapshot(await window.railgunDesktop.resumeSession(sessionId));
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
    newChat: () => { void startNewTask(); },
    showChat: () => selectArea("chat"),
    showSettings: () => selectArea("settings"),
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
    <main className="loading-shell">
      <LoadingState title="Connecting to Railgun…" description="Starting the secure desktop connection." />
    </main>
  ) : (
    <main className="loading-shell">
      <ErrorState title="Unable to connect" description={bootstrapError} />
    </main>
  );

  const sidebar = <>
        <div className="brand"><span className="brand-mark"><Bot /></span><span>Railgun</span></div>
        <Button className="sidebar-action new-task" variant="ghost" disabled={sessionOperation} onClick={() => void startNewTask()}><SquarePen aria-hidden="true" />New Task</Button>
        <section className="session-navigation" aria-label="Tasks">
          <div className="session-list">
            {sessionsLoading ? <p role="status">Loading sessions…</p> : sessionsError !== undefined ? <div role="alert"><p>{sessionsError}</p><Button size="sm" variant="ghost" onClick={() => void loadSessions()}>Retry</Button></div>
              : sessions.length === 0 ? <p>No saved tasks</p>
                : sessions.map(session => <DropdownMenu open={contextSessionId === session.id} onOpenChange={open => setContextSessionId(open ? session.id : undefined)} key={session.id}>
                    <div className="session-row-context">
                      <button
                        type="button"
                        className={`session-row ${activeSession?.id === session.id ? "active" : ""}`}
                        aria-current={activeSession?.id === session.id ? "true" : undefined}
                        disabled={sessionOperation}
                        onContextMenu={event => { event.preventDefault(); if (!sessionOperation) setContextSessionId(session.id); }}
                        onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); setContextSessionId(session.id); } }}
                        onClick={() => void resumeSession(session.id)}
                      ><strong>{session.firstUserPreview || "Untitled chat"}</strong><span>{session.model} · {session.startedAtLocal}</span></button>
                      <DropdownMenuTrigger asChild><span className="session-context-anchor" aria-hidden="true" /></DropdownMenuTrigger>
                    </div>
                    <DropdownMenuContent align="start"><DropdownMenuItem disabled={sessionOperation} onSelect={() => void forkSession(session.id)}><GitFork aria-hidden="true" />Fork task</DropdownMenuItem></DropdownMenuContent>
                  </DropdownMenu>)}
          </div>
        </section>
        <div className="sidebar-divider" aria-hidden="true" />
        <Button variant="ghost" className={`sidebar-action sidebar-settings${area === "settings" ? " active" : ""}`} aria-current={area === "settings" ? "page" : undefined} onClick={() => selectArea("settings")}><Settings aria-hidden="true" />Settings</Button>
        <div className="sidebar-footer"><span className={`connection-dot ${snapshot.phase}`} aria-hidden="true" /><span>{PHASE_COPY[snapshot.phase].title}</span></div>
      </>;
  const toolbarActions = area === "chat" ? <div className="content-toolbar-actions">
    <div className="checkpoint-status">{running || activeSession?.checkpoint.state === "pending" ? "Saving…" : activeSession?.checkpoint.state === "saved" ? "Saved" : activeSession?.checkpoint.state === "error" ? <details><summary>Save failed</summary><span>{activeSession.checkpoint.detail}</span></details> : "Not saved"}</div>
    <Button
      type="button"
      variant="sidebarIcon"
      size="icon"
      className="todo-pane-toggle"
      aria-label={hasActivity && todoPaneVisible ? "Hide Todos" : "Show Todos"}
      aria-pressed={hasActivity && todoPaneVisible}
      disabled={!hasActivity}
      title={hasActivity && todoPaneVisible ? "Hide Todos" : "Show Todos"}
      onClick={() => setTodoPaneVisible(visible => !visible)}
    ><SlidersHorizontal aria-hidden="true" /></Button>
  </div> : undefined;
  const content = area === "chat" ? (
        <section className="chat-surface">
          <header className="content-toolbar">
            <div className="content-toolbar-title"><h1>{activeSession?.transcript.find(message => message.role === "user")?.text.slice(0, 500) ?? "New Task"}</h1><p>{activeSession?.model ?? (snapshot.mode === "mock" ? "Mock backend" : "Devin provider")}</p></div>
          </header>
          {operationError === undefined ? null : <div className="shell-error" role="alert">{operationError}</div>}
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
          />
        </section>
      ) : (
        <section className="settings-surface">
          <header className="content-toolbar"><div className="content-toolbar-title"><h1>Settings</h1><p>Runtime and diagnostics</p></div></header>
          {operationError === undefined ? null : <div className="shell-error" role="alert">{operationError}</div>}
          <div className="settings-content">
            <BackendStatus snapshot={snapshot} onRetry={restartBackend} />
            {snapshot.mode === "mock" ? <MockPanel snapshot={snapshot} scenarios={scenarios} onSelect={selectMockScenario} /> : null}
            <Card className="boundary-note"><CardHeader><TerminalSquare /><div><h2>Secure desktop boundary</h2><p>Renderer access is limited to the validated Railgun API.</p></div></CardHeader></Card>
          </div>
        </section>
      );

  return (
    <>
      <ShellLayout
        sidebar={sidebar}
        sidebarAction={<Button type="button" variant="sidebarIcon" size="compactIcon" className="task-search-button" aria-label="Search tasks" disabled={sessionOperation} onClick={openTaskPalette}><Search aria-hidden="true" /></Button>}
        collapsedSidebarAction={<Button type="button" variant="sidebarIcon" size="icon" aria-label="New Task" disabled={sessionOperation} onClick={() => void startNewTask()}><SquarePen aria-hidden="true" /></Button>}
        main={content}
        mainAction={toolbarActions}
        inspector={hasActivity ? <ActivityInspector activity={chat.state.activity} /> : undefined}
        inspectorVisible={todoPaneVisible}
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
        <DialogContent className="branch-dialog">
          <DialogHeader><DialogTitle>Branch from this message?</DialogTitle><DialogDescription>This rewinds the active task to this message. Later messages remain preserved in the abandoned branch.</DialogDescription></DialogHeader>
          <label className="branch-summary-option"><input type="checkbox" checked={branchSummarize} disabled={branchSubmitting} onChange={event => setBranchSummarize(event.target.checked)} /> <span>Summarize later messages</span></label>
          {branchError === undefined ? null : <p className="branch-dialog-error" role="alert">{branchError}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={branchSubmitting} onClick={() => setBranchMessageId(undefined)}>Cancel</Button>
            <Button type="button" variant="tonal" disabled={branchSubmitting} onClick={() => void branchSession()}>{branchSubmitting ? "Branching…" : "Branch"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
