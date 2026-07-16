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
  const statusColor = snapshot.phase === "ready" ? "bg-success" : isFailure ? "bg-destructive" : "bg-warning";
  return (
    <Card
      className="mx-auto mb-5 w-[min(45rem,100%)]"
      role={isFailure ? "alert" : "status"}
      aria-live={isFailure ? "assertive" : "polite"}
    >
      <CardHeader>
        <div className={`mb-3 size-2.5 rounded-full ${statusColor}`} aria-hidden="true" />
        <p className="mb-1 text-[0.625rem] font-bold uppercase tracking-[0.09em] text-foreground-secondary">Backend status</p>
        <h1 className="mb-1 mt-0 text-heading">{copy.title}</h1>
        <p className="m-0 text-control text-foreground-secondary">{copy.description}</p>
      </CardHeader>
      <CardContent>
        {snapshot.error === undefined ? null : <p className="font-semibold text-destructive">{snapshot.error}</p>}
        {snapshot.diagnostics.length === 0 ? null : <details className="mt-4"><summary>Diagnostics</summary><pre className="overflow-auto whitespace-pre-wrap rounded-sm bg-surface-muted p-3">{snapshot.diagnostics.join("\n")}</pre></details>}
        {onRetry !== undefined && RETRYABLE_PHASES.has(snapshot.phase)
          ? <Button type="button" variant="secondary" onClick={() => void onRetry()}>Retry</Button>
          : null}
      </CardContent>
    </Card>
  );
};
