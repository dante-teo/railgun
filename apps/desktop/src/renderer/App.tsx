import { useEffect, useRef, useState } from "react";
import { Bot, CirclePlus, MessageSquare, PanelLeft, Send, Settings, Square, TerminalSquare } from "lucide-react";
import { MockScenarioIdSchema } from "../shared/schemas";
import type { BackendPhase, BackendSnapshot, MockScenario } from "../shared/types";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader } from "./components/ui/card";
import { Textarea } from "./components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "./components/ui/state";

const PHASE_COPY: Record<BackendPhase, { readonly title: string; readonly description: string }> = {
  starting: { title: "Starting Railgun", description: "Checking the local backend connection…" },
  ready: { title: "Railgun is ready", description: "The desktop process boundary is connected." },
  "authentication-required": {
    title: "Sign in to Devin",
    description: "Resolve the Devin credential issue below, then retry the backend connection.",
  },
  failed: { title: "Railgun could not start", description: "Review the diagnostic details below." },
  disconnected: { title: "Railgun disconnected", description: "The backend process exited after connecting." },
};
const RETRYABLE_PHASES: ReadonlySet<BackendPhase> = new Set([
  "authentication-required",
  "failed",
  "disconnected",
]);

export interface BackendStatusProps {
  readonly snapshot: BackendSnapshot;
  readonly onRetry?: () => Promise<void>;
}

export const BackendStatus = ({ snapshot, onRetry }: BackendStatusProps): React.JSX.Element => {
  const copy = PHASE_COPY[snapshot.phase];
  const isFailure = snapshot.phase === "failed" || snapshot.phase === "disconnected";
  return (
    <Card
      className={`status status-${snapshot.phase}`}
      role={isFailure ? "alert" : "status"}
      aria-live={isFailure ? "assertive" : "polite"}
    >
      <CardHeader>
        <div className="status-mark" aria-hidden="true" />
        <p className="eyebrow">Backend status</p>
        <h1>{copy.title}</h1>
        <p className="description">{copy.description}</p>
      </CardHeader>
      <CardContent>
        {snapshot.error === undefined ? null : <p className="error-detail">{snapshot.error}</p>}
        {snapshot.diagnostics.length === 0 ? null : <details><summary>Diagnostics</summary><pre>{snapshot.diagnostics.join("\n")}</pre></details>}
        {onRetry !== undefined && RETRYABLE_PHASES.has(snapshot.phase)
          ? <Button type="button" variant="glass" onClick={() => void onRetry()}>Retry</Button>
          : null}
      </CardContent>
    </Card>
  );
};

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

interface ChatMessage { readonly id: number; readonly role: "user" | "assistant" | "error"; readonly text: string }

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export const App = (): React.JSX.Element => {
  const [snapshot, setSnapshot] = useState<BackendSnapshot>();
  const [scenarios, setScenarios] = useState<readonly MockScenario[]>([]);
  const [area, setArea] = useState<"chat" | "settings">("chat");
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string>();
  const nextMessageId = useRef(1);

  useEffect(() => {
    let active = true;
    void window.railgunDesktop.getBackendSnapshot().then(
      (next) => { if (active) setSnapshot(next); },
      (error: unknown) => { if (active) setBootstrapError(errorText(error, "Unable to connect to Railgun")); },
    );
    void window.railgunDesktop.listMockScenarios().then(
      (next) => { if (active) setScenarios(next); },
      (error: unknown) => { if (active) setBootstrapError(errorText(error, "Unable to load diagnostics")); },
    );
    const unsubscribeSnapshot = window.railgunDesktop.onBackendSnapshot(setSnapshot);
    const unsubscribeAgent = window.railgunDesktop.onAgentEvent((event) => {
      if (event.type === "run-start") setRunning(true);
      if (event.type === "run-end") setRunning(false);
      if (event.type === "assistant-delta") {
        setMessages((current) => {
          const last = current.at(-1);
          if (last?.role === "assistant") return [...current.slice(0, -1), { ...last, text: last.text + event.text }];
          return [...current, { id: nextMessageId.current++, role: "assistant", text: event.text }];
        });
      }
    });
    return () => { active = false; unsubscribeSnapshot(); unsubscribeAgent(); };
  }, []);

  useEffect(() => {
    if (snapshot?.phase !== "ready") setRunning(false);
  }, [snapshot?.phase]);

  const send = async (): Promise<void> => {
    const message = draft.trim();
    if (message.length === 0 || snapshot?.phase !== "ready" || running) return;
    setDraft("");
    setRunning(true);
    setMessages((current) => [...current, { id: nextMessageId.current++, role: "user", text: message }]);
    try {
      await window.railgunDesktop.sendPrompt(message);
    } catch (error) {
      setRunning(false);
      setMessages((current) => [...current, {
        id: nextMessageId.current++,
        role: "error",
        text: errorText(error, "The request failed"),
      }]);
    }
  };

  const abort = async (): Promise<boolean> => {
    try {
      await window.railgunDesktop.abortPrompt();
      return true;
    } catch (error) {
      setRunning(false);
      setMessages((current) => [...current, {
        id: nextMessageId.current++,
        role: "error",
        text: errorText(error, "Unable to stop the request"),
      }]);
      return false;
    }
  };

  const startNewChat = async (): Promise<void> => {
    if (running && !await abort()) return;
    try {
      const nextSnapshot = await window.railgunDesktop.startNewChat();
      setSnapshot(nextSnapshot);
      setMessages([]);
      setArea("chat");
    } catch (error) {
      setMessages((current) => [...current, {
        id: nextMessageId.current++,
        role: "error",
        text: errorText(error, "Unable to start a new chat"),
      }]);
    }
  };

  const restartBackend = async (): Promise<void> => {
    try {
      setSnapshot(await window.railgunDesktop.restartBackend());
    } catch (error) {
      setMessages((current) => [...current, {
        id: nextMessageId.current++,
        role: "error",
        text: errorText(error, "Unable to restart the backend"),
      }]);
    }
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

  return (
    <main className={`desktop-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <div className="titlebar" aria-hidden="true" />
      <aside id="app-sidebar" className="sidebar" aria-hidden={sidebarCollapsed} inert={sidebarCollapsed}>
        <div className="brand"><span className="brand-mark"><Bot /></span><span>Railgun</span></div>
        <Button className="new-chat" variant="glass" onClick={() => void startNewChat()}><CirclePlus aria-hidden="true" />New chat</Button>
        <nav aria-label="Main navigation">
          <Button variant="ghost" className={area === "chat" ? "active" : ""} aria-current={area === "chat" ? "page" : undefined} onClick={() => setArea("chat")}><MessageSquare aria-hidden="true" />Chat</Button>
          <Button variant="ghost" className={area === "settings" ? "active" : ""} aria-current={area === "settings" ? "page" : undefined} onClick={() => setArea("settings")}><Settings aria-hidden="true" />Settings</Button>
        </nav>
        <div className="sidebar-footer"><span className={`connection-dot ${snapshot.phase}`} aria-hidden="true" /><span>{PHASE_COPY[snapshot.phase].title}</span></div>
      </aside>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="sidebar-toggle"
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-controls="app-sidebar"
        aria-expanded={!sidebarCollapsed}
        onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
      >
        <PanelLeft aria-hidden="true" />
      </Button>

      {area === "chat" ? (
        <section className="chat-surface">
          <header className="content-toolbar"><div className="content-toolbar-title"><h1>New chat</h1><p>{snapshot.mode === "mock" ? "Mock backend" : "Devin provider"}</p></div></header>
          <div className={`transcript ${messages.length === 0 ? "empty" : ""}`}>
            {messages.length === 0 && snapshot.phase === "ready" ? <EmptyState className="welcome" icon={<Bot />} title="What are we building?" description="Ask Railgun to inspect, explain, or change your project." /> : null}
            {messages.length === 0 && snapshot.phase !== "ready" ? <BackendStatus snapshot={snapshot} onRetry={restartBackend} /> : null}
            {messages.map((message) => (
              <article className={`message ${message.role}`} role={message.role === "error" ? "alert" : undefined} key={message.id}>
                <div className="message-role">{message.role === "user" ? "You" : message.role === "assistant" ? "Railgun" : "Error"}</div>
                <p>{message.text}</p>
              </article>
            ))}
            {running && messages.at(-1)?.role !== "assistant" ? <div className="thinking"><i /><i /><i /><span>Railgun is thinking</span></div> : null}
          </div>
          <div className="composer-wrap">
            <div className="composer">
              <Textarea
                aria-label="Message Railgun"
                placeholder={snapshot.phase === "ready" ? "Message Railgun…" : "Backend unavailable"}
                value={draft}
                disabled={snapshot.phase !== "ready"}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
                }}
              />
              {running ? (
                <Button variant="destructive" size="icon" className="send-button" aria-label="Stop" onClick={() => void abort()}><Square aria-hidden="true" /></Button>
              ) : (
                <Button size="icon" className="send-button" aria-label="Send" disabled={draft.trim().length === 0 || snapshot.phase !== "ready"} onClick={() => void send()}><Send aria-hidden="true" /></Button>
              )}
            </div>
            <p className="composer-hint">Railgun can make mistakes. Review changes before committing.</p>
          </div>
        </section>
      ) : (
        <section className="settings-surface">
          <header className="content-toolbar"><div className="content-toolbar-title"><h1>Settings</h1><p>Runtime and diagnostics</p></div></header>
          <div className="settings-content">
            <BackendStatus snapshot={snapshot} onRetry={restartBackend} />
            {snapshot.mode === "mock" ? <MockPanel snapshot={snapshot} scenarios={scenarios} onSelect={async (value) => {
              setSnapshot(await window.railgunDesktop.selectMockScenario(MockScenarioIdSchema.parse(value)));
            }} /> : null}
            <Card className="boundary-note"><CardHeader><TerminalSquare /><div><h2>Secure desktop boundary</h2><p>Renderer access is limited to the validated Railgun API.</p></div></CardHeader></Card>
          </div>
        </section>
      )}
    </main>
  );
};
