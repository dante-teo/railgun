import type { BackendPhase, BackendSnapshot } from "../shared/types";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader } from "./components/ui/card";

export const PHASE_COPY: Record<BackendPhase, { readonly title: string; readonly description: string }> = {
  starting: { title: "Starting Railgun", description: "Checking the local backend connection…" },
  ready: { title: "Railgun is ready", description: "The desktop process boundary is connected." },
  "authentication-required": {
    title: "Sign in to Devin",
    description: "Resolve the Devin credential issue below, then retry the backend connection.",
  },
  failed: { title: "Railgun could not start", description: "Review the diagnostic details below." },
  disconnected: { title: "Railgun disconnected", description: "The backend process exited after connecting." },
};

export const RETRYABLE_PHASES: ReadonlySet<BackendPhase> = new Set([
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
          ? <Button type="button" variant="tonal" onClick={() => void onRetry()}>Retry</Button>
          : null}
      </CardContent>
    </Card>
  );
};
