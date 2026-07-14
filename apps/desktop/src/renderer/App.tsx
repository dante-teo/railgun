import { useEffect, useRef, useState } from "react";
import { Bot, CirclePlus, MessageSquare, Settings, TerminalSquare } from "lucide-react";
import { MockScenarioIdSchema } from "../shared/schemas";
import type { AppCommand, BackendSnapshot, MockScenario } from "../shared/types";
import { Button } from "./components/ui/button";
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
export { BackendStatus } from "./backendStatus";

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
          <Button type="button" variant="glass" disabled={restarting || selectedId.length === 0} onClick={() => void restart()}>
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
  const [area, setArea] = useState<"chat" | "settings">("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [controlsResetKey, setControlsResetKey] = useState(0);
  const paletteRestoreFocus = useRef<HTMLElement | null>(null);
  const appCommandHandler = useRef<(command: AppCommand) => void>(() => undefined);
  const chat = useChatController(snapshot);
  const running = chat.state.running;

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
    return () => { active = false; unsubscribeSnapshot(); };
  }, []);

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

  const startNewChat = async (): Promise<void> => {
    if (running && !await chat.stop()) return;
    try {
      setOperationError(undefined);
      const nextSnapshot = await window.railgunDesktop.startNewChat();
      setSnapshot(nextSnapshot);
      chat.reset();
      setControlsResetKey(key => key + 1);
      setArea("chat");
    } catch (error) {
      setOperationError(errorMessage(error, "Unable to start a new chat"));
    }
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
  const commands = createCommandRegistry({
    newChat: () => { void startNewChat(); },
    showChat: () => setArea("chat"),
    showSettings: () => setArea("settings"),
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
        <Button className="new-chat" variant="glass" onClick={() => void startNewChat()}><CirclePlus aria-hidden="true" />New chat</Button>
        <nav aria-label="Main navigation">
          <Button variant="ghost" className={area === "chat" ? "active" : ""} aria-current={area === "chat" ? "page" : undefined} onClick={() => setArea("chat")}><MessageSquare aria-hidden="true" />Chat</Button>
          <Button variant="ghost" className={area === "settings" ? "active" : ""} aria-current={area === "settings" ? "page" : undefined} onClick={() => setArea("settings")}><Settings aria-hidden="true" />Settings</Button>
        </nav>
        <div className="sidebar-footer"><span className={`connection-dot ${snapshot.phase}`} aria-hidden="true" /><span>{PHASE_COPY[snapshot.phase].title}</span></div>
      </>;
  const content = area === "chat" ? (
        <section className="chat-surface">
          <header className="content-toolbar"><div className="content-toolbar-title"><h1>New chat</h1><p>{snapshot.mode === "mock" ? "Mock backend" : "Devin provider"}</p></div></header>
          {operationError === undefined ? null : <div className="shell-error" role="alert">{operationError}</div>}
          <Transcript controller={chat} snapshot={snapshot} onRestart={restartBackend} />
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
        main={content}
        inspector={chat.state.activity.todos.length > 0 || chat.state.activity.subagents.length > 0 || chat.state.activity.todoLoading
          ? <ActivityInspector activity={chat.state.activity} />
          : undefined}
        sidebarVisible={!sidebarCollapsed}
        onSidebarVisibilityChange={(visible) => setSidebarCollapsed(!visible)}
      />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        restoreFocusTo={paletteRestoreFocus.current}
        onOpenChange={setPaletteOpen}
      />
    </>
  );
};
