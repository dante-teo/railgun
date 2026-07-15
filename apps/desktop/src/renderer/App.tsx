import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, PanelRightOpen, Search, Settings, SlidersHorizontal, SquarePen } from "lucide-react";
import { MockScenarioIdSchema } from "../shared/schemas";
import type { AppCommand, BackendSnapshot, MockScenario, SessionSnapshot, SessionSummary } from "../shared/types";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { ErrorState, LoadingState } from "./components/ui/state";
import { CommandPalette } from "./commands/CommandPalette";
import { commandFromKeyboardEvent, createCommandRegistry } from "./commands/commandRegistry";
import { ShellLayout } from "./shell/ShellLayout";
import { ActivityInspector, Composer, Transcript, useChatController } from "./chat/Chat";
import { ChatToolbarControls } from "./chat/ChatControls";
import { PHASE_COPY, RETRYABLE_PHASES } from "./backendStatus";
import { errorMessage } from "./lib/utils";
import { readStoredArea, writeStoredArea } from "./routeStorage";
import type { AppArea } from "./routeStorage";
import { TaskPalette } from "./tasks/TaskPalette";
import { FileBrowser } from "./files/FileBrowser";
import type { InspectorLayoutMode } from "./shell/inspectorLayout";
import { SettingsPage } from "./settings/SettingsPage";
import { AutomationPage } from "./automation/AutomationPage";

export const App = (): React.JSX.Element => {
  const [snapshot, setSnapshot] = useState<BackendSnapshot>();
  const [scenarios, setScenarios] = useState<readonly MockScenario[]>([]);
  const [area, setArea] = useState<AppArea>(() => readStoredArea(window.localStorage));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarScrolled, setSidebarScrolled] = useState(false);
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
  const activityLayoutMode = useRef<InspectorLayoutMode | undefined>(undefined);
  const appCommandHandler = useRef<(command: AppCommand) => void>(() => undefined);
  const chat = useChatController(snapshot);
  const running = chat.state.running;
  const hasActivity = chat.state.activity.todos.length > 0
    || chat.state.activity.subagents.length > 0
    || chat.state.activity.todoLoading;
  const handleInspectorLayoutModeChange = useCallback((mode: InspectorLayoutMode): void => {
    if (activityLayoutMode.current === mode) return;
    activityLayoutMode.current = mode;
    setActivityPaneVisible(mode === "reserved");
  }, []);

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
  const requestNewTask = (): void => guardSettingsExit(() => { void startNewTask(); });

  const resumeSession = async (sessionId: string): Promise<void> => {
    if (sessionOperation) return;
    if (sessionId === activeSession?.id) { selectArea("chat"); return; }
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
    <main className="loading-shell">
      <LoadingState title="Connecting to Railgun…" description="Starting the secure desktop connection." />
    </main>
  ) : (
    <main className="loading-shell">
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
    />
    <Dialog open={pendingSettingsExit !== undefined} onOpenChange={open => { if (!open) setPendingSettingsExit(undefined); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Discard unsaved changes?</DialogTitle><DialogDescription>Your instruction edits have not been saved.</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => setPendingSettingsExit(undefined)}>Cancel</Button>
          <Button variant="destructive" onClick={() => { const action = pendingSettingsExit; setPendingSettingsExit(undefined); setSettingsDirty(false); action?.(); }}>Discard Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
  const sidebar = <>
        <div className="sidebar-pinned-top">
          <div className="brand"><span>Railgun</span></div>
          <Button className="sidebar-action new-task" variant="ghost" disabled={sessionOperation} onClick={() => void startNewTask()}><SquarePen aria-hidden="true" />New Task</Button>
        </div>
        <div className={`sidebar-top-divider${sidebarScrolled ? " visible" : ""}`} aria-hidden="true" />
        <div
          className="sidebar-scroll"
          onScroll={e => {
            const next = (e.currentTarget as HTMLDivElement).scrollTop > 0;
            setSidebarScrolled(prev => prev === next ? prev : next);
          }}
        >
          <Button variant="ghost" className={`sidebar-action sidebar-automation${area === "automation" ? " active" : ""}`} onClick={() => selectArea("automation")}><Clock aria-hidden="true" />Scheduled</Button>
          <section className="session-navigation" aria-label="Tasks">
            <p className="sidebar-list-heading">Tasks</p>
            <div className="session-list">
              {sessionsLoading ? <p role="status">Loading sessions…</p> : sessionsError !== undefined ? <div role="alert"><p>{sessionsError}</p><Button size="sm" variant="ghost" onClick={() => void loadSessions()}>Retry</Button></div>
                : sessions.length === 0 ? <p>No saved tasks</p>
                  : sessions.map(session => (
                      <button
                        key={session.id}
                        type="button"
                        className={`session-row ${activeSession?.id === session.id ? "active" : ""}`}
                        aria-current={activeSession?.id === session.id ? "true" : undefined}
                        disabled={sessionOperation}
                        onContextMenu={event => { event.preventDefault(); openSessionContextMenu(session.id); }}
                        onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); openSessionContextMenu(session.id); } }}
                        onClick={() => void resumeSession(session.id)}
                      ><strong>{session.firstUserPreview || "Untitled chat"}</strong><span>{session.model} · {session.startedAtLocal}</span></button>
                    ))}
            </div>
          </section>
        </div>
        <div className="sidebar-bottom-divider" aria-hidden="true" />
        <div className="sidebar-bottom">
          <Button variant="ghost" className="sidebar-action sidebar-settings" onClick={() => selectArea("settings")}><Settings aria-hidden="true" />Settings</Button>
          <div className="sidebar-footer"><span className={`connection-dot ${snapshot.phase}`} aria-hidden="true" /><span>{PHASE_COPY[snapshot.phase].title}</span></div>
        </div>
      </>;
  const todoPaneToggle = <Button
      type="button"
      variant="sidebarIcon"
      size="icon"
      className="todo-pane-toggle"
      aria-label={hasActivity && activityPaneVisible ? "Hide Todos" : "Show Todos"}
      aria-pressed={hasActivity && activityPaneVisible}
      disabled={!hasActivity}
      title={hasActivity && activityPaneVisible ? "Hide Todos" : "Show Todos"}
      onClick={() => setActivityPaneVisible(visible => !visible)}
    ><SlidersHorizontal aria-hidden="true" /></Button>;
  const filesPaneToggle = <Button
      type="button"
      variant="sidebarIcon"
      size="icon"
      className="files-pane-toggle"
      aria-label="Open Files"
      aria-pressed="false"
      title="Open Files"
      onClick={() => setFilesPaneVisible(true)}
    ><PanelRightOpen aria-hidden="true" /></Button>;
  const toolbarActions = <div className="content-toolbar-actions">
    <div className="checkpoint-status">{running || activeSession?.checkpoint.state === "pending" ? "Saving…" : activeSession?.checkpoint.state === "saved" ? "Saved" : activeSession?.checkpoint.state === "error" ? <details><summary>Save failed</summary><span>{activeSession.checkpoint.detail}</span></details> : "Not saved"}</div>
    {filesPaneVisible ? todoPaneToggle : <div className="right-pane-controls">{todoPaneToggle}{filesPaneToggle}</div>}
  </div>;
  const chatContent = <section className="chat-surface">
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
        </section>;
  const content = area === "automation"
    ? <AutomationPage backendPhase={snapshot.phase} />
    : chatContent;

  return (
    <>
      <ShellLayout
        sidebar={sidebar}
        sidebarAction={<Button type="button" variant="sidebarIcon" size="compactIcon" className="task-search-button" aria-label="Search tasks" disabled={sessionOperation} onClick={openTaskPalette}><Search aria-hidden="true" /></Button>}
        collapsedSidebarAction={<Button type="button" variant="sidebarIcon" size="icon" aria-label="New Task" disabled={sessionOperation} onClick={() => void startNewTask()}><SquarePen aria-hidden="true" /></Button>}
        main={content}
        mainAction={area === "chat" ? toolbarActions : undefined}
        inspector={area === "chat" && hasActivity ? <ActivityInspector activity={chat.state.activity} /> : undefined}
        inspectorVisible={area === "chat" && activityPaneVisible}
        workspace={area === "chat" ? <FileBrowser onCollapse={() => setFilesPaneVisible(false)} /> : undefined}
        workspaceVisible={area === "chat" && filesPaneVisible}
        sidebarVisible={!sidebarCollapsed}
        onSidebarVisibilityChange={(visible) => setSidebarCollapsed(!visible)}
        onInspectorLayoutModeChange={handleInspectorLayoutModeChange}
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
