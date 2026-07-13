import { useEffect, useState } from "react";
import type { BackendPhase, BackendSnapshot, MockScenario } from "../shared/types";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader } from "./components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";

const PHASE_COPY: Record<BackendPhase, { readonly title: string; readonly description: string }> = {
  starting: { title: "Starting Railgun", description: "Checking the local backend connection…" },
  ready: { title: "Railgun is ready", description: "The desktop process boundary is connected." },
  failed: { title: "Railgun could not start", description: "Review the diagnostic details below." },
  disconnected: { title: "Railgun disconnected", description: "The backend process exited after connecting." },
};

export interface BackendStatusProps {
  readonly snapshot: BackendSnapshot;
}

export const BackendStatus = ({ snapshot }: BackendStatusProps): React.JSX.Element => {
  const copy = PHASE_COPY[snapshot.phase];
  return (
    <Card className={`status status-${snapshot.phase}`} aria-live="polite">
      <CardHeader>
        <div className="status-mark" aria-hidden="true" />
        <p className="eyebrow">Backend status</p>
        <h1>{copy.title}</h1>
        <p className="description">{copy.description}</p>
      </CardHeader>
      <CardContent>
        {snapshot.error === undefined ? null : <p className="error-detail">{snapshot.error}</p>}
        {snapshot.diagnostics.length === 0 ? null : (
          <details>
            <summary>Diagnostics</summary>
            <pre>{snapshot.diagnostics.join("\n")}</pre>
          </details>
        )}
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

  useEffect(() => {
    if (snapshot.scenarioId !== undefined) setSelectedId(snapshot.scenarioId);
  }, [snapshot.scenarioId]);

  const restart = async (): Promise<void> => {
    if (selectedId.length === 0) return;
    setRestarting(true);
    try {
      await onSelect(selectedId);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <Card className="mock-panel">
      <CardHeader>
        <p className="eyebrow">Mock developer panel</p>
        <h2>Backend scenario</h2>
      </CardHeader>
      <CardContent>
        <div className="scenario-controls">
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger aria-label="Mock scenario"><SelectValue placeholder="Choose a scenario" /></SelectTrigger>
            <SelectContent>
              {scenarios.map((scenario) => <SelectItem value={scenario.id} key={scenario.id}>{scenario.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button type="button" disabled={restarting || selectedId.length === 0} onClick={() => void restart()}>
            {restarting ? "Restarting…" : "Restart backend"}
          </Button>
        </div>
        <p className="scenario-description">
          {scenarios.find((scenario) => scenario.id === selectedId)?.description}
        </p>
        <div className="transport">
          <h3>Transport log</h3>
          <ol>
            {snapshot.transportLog.map((entry, index) => (
              <li key={`${String(index)}-${entry.direction}`}>
                <span>{entry.direction}</span>
                <code>{entry.text}</code>
              </li>
            ))}
          </ol>
        </div>
      </CardContent>
    </Card>
  );
};

export const App = (): React.JSX.Element => {
  const [snapshot, setSnapshot] = useState<BackendSnapshot>();
  const [scenarios, setScenarios] = useState<readonly MockScenario[]>([]);

  useEffect(() => {
    let active = true;
    void window.railgunDesktop.getBackendSnapshot().then((next) => {
      if (active) setSnapshot(next);
    });
    void window.railgunDesktop.listMockScenarios().then((next) => {
      if (active) setScenarios(next);
    });
    const unsubscribe = window.railgunDesktop.onBackendSnapshot(setSnapshot);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (snapshot === undefined) return <main className="app-shell"><p>Connecting to Railgun…</p></main>;

  return (
    <main className="app-shell">
      <BackendStatus snapshot={snapshot} />
      {snapshot.mode === "mock" ? (
        <MockPanel
          snapshot={snapshot}
          scenarios={scenarios}
          onSelect={async (id) => {
            setSnapshot(await window.railgunDesktop.selectMockScenario(id));
          }}
        />
      ) : null}
    </main>
  );
};
