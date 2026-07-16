import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, Pencil, Plus, Trash2 } from "lucide-react";
import { parseCronSchedule } from "../../shared/cron";
import { DESKTOP_CRON_LIMITS } from "../../shared/schemas";
import type { BackgroundAutomationStatus, BackendPhase, CronJob, CronJobInput } from "../../shared/types";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input, Textarea } from "../components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { errorMessage } from "../lib/utils";

interface AutomationPageProps {
  readonly backendPhase: BackendPhase;
}

interface EditorState {
  readonly job?: CronJob;
  schedule: string;
  prompt: string;
}

const initialEditor = (job?: CronJob): EditorState => ({
  ...(job === undefined ? {} : { job }),
  schedule: job?.schedule ?? "",
  prompt: job?.prompt ?? "",
});

export const AutomationPage = ({ backendPhase }: AutomationPageProps): React.JSX.Element => {
  const [jobs, setJobs] = useState<readonly CronJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [editor, setEditor] = useState<EditorState>();
  const [deleting, setDeleting] = useState<CronJob>();
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string>();
  const [automation, setAutomation] = useState<BackgroundAutomationStatus>();
  const [automationBusy, setAutomationBusy] = useState(false);
  const [automationError, setAutomationError] = useState<string>();
  const loadGeneration = useRef(0);
  const ready = backendPhase === "ready";

  const load = useCallback(async (): Promise<void> => {
    if (!ready) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(undefined);
    try {
      const next = await window.railgunDesktop.listCronJobs();
      if (generation === loadGeneration.current) setJobs(next);
    } catch (error) {
      if (generation === loadGeneration.current) setLoadError(errorMessage(error, "Unable to load scheduled jobs"));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [ready]);

  useEffect(() => {
    if (ready) void load();
    else {
      loadGeneration.current += 1;
      setLoading(false);
      setLoadError(undefined);
    }
    return () => { loadGeneration.current += 1; };
  }, [ready, load]);

  const loadAutomation = useCallback(async (): Promise<void> => {
    try {
      setAutomation(await window.railgunDesktop.getAutomationStatus());
      setAutomationError(undefined);
    } catch (error) {
      setAutomationError(errorMessage(error, "Unable to read background automation status"));
    }
  }, []);

  useEffect(() => { void loadAutomation(); }, [loadAutomation]);

  const setAutomationEnabled = async (enabled: boolean): Promise<void> => {
    if (automationBusy || automation?.state === "unavailable") return;
    setAutomationBusy(true);
    setAutomationError(undefined);
    try {
      setAutomation(enabled
        ? await window.railgunDesktop.enableAutomation()
        : await window.railgunDesktop.disableAutomation());
    } catch (error) {
      setAutomationError(errorMessage(error, "Unable to update background automation"));
    } finally { setAutomationBusy(false); }
  };

  const repairAutomation = async (): Promise<void> => {
    if (automationBusy) return;
    setAutomationBusy(true);
    setAutomationError(undefined);
    try { setAutomation(await window.railgunDesktop.repairAutomation()); }
    catch (error) { setAutomationError(errorMessage(error, "Unable to repair background automation")); }
    finally { setAutomationBusy(false); }
  };

  const scheduleResult = parseCronSchedule(editor?.schedule ?? "");
  const promptValid = (editor?.prompt.trim().length ?? 0) > 0;
  const editorValid = scheduleResult.valid && promptValid;

  const save = async (): Promise<void> => {
    if (editor === undefined || !ready || busy || !scheduleResult.valid || !promptValid) return;
    const input: CronJobInput = { schedule: scheduleResult.schedule, prompt: editor.prompt.trim() };
    loadGeneration.current += 1;
    setLoading(false);
    setBusy(true);
    setMutationError(undefined);
    try {
      const saved = editor.job === undefined
        ? await window.railgunDesktop.createCronJob(input)
        : await window.railgunDesktop.updateCronJob(editor.job.id, input);
      setJobs(current => editor.job === undefined
        ? [...current, saved]
        : current.map(job => job.id === saved.id ? saved : job));
      setEditor(undefined);
    } catch (error) {
      setMutationError(errorMessage(error, editor.job === undefined ? "Unable to create scheduled job" : "Unable to update scheduled job"));
      void load();
    } finally { setBusy(false); }
  };

  const remove = async (): Promise<void> => {
    if (deleting === undefined || !ready || busy) return;
    loadGeneration.current += 1;
    setLoading(false);
    setBusy(true);
    setMutationError(undefined);
    try {
      await window.railgunDesktop.deleteCronJob(deleting.id);
      setJobs(current => current.filter(job => job.id !== deleting.id));
      setDeleting(undefined);
    } catch (error) {
      setMutationError(errorMessage(error, "Unable to delete scheduled job"));
      void load();
    } finally { setBusy(false); }
  };

  const openEditor = (job?: CronJob): void => {
    setMutationError(undefined);
    setEditor(initialEditor(job));
  };
  const openDelete = (job: CronJob): void => {
    setMutationError(undefined);
    setDeleting(job);
  };

  return <section className="automation-page">
    <header className="content-toolbar automation-toolbar">
      <div className="content-toolbar-title"><h1>Scheduled</h1><p>Scheduled prompts run in your local timezone.</p></div>
      <div className="content-toolbar-actions"><Button className="automation-create" size="sm" variant="ghost" disabled={!ready || busy} onClick={() => openEditor()}><Plus aria-hidden="true" />Create</Button></div>
    </header>
    <div className="automation-scroll">
      <section className="automation-background" aria-label="Background automation">
        <div><strong>Background automation</strong><p>Enable both scheduled prompts and nightly maintenance while Railgun is closed.</p></div>
        <label className="settings-switch"><input aria-label="Enable background automation" type="checkbox" checked={automation?.enabled ?? false} disabled={automationBusy || automation?.state === "unavailable"} onChange={event => void setAutomationEnabled(event.target.checked)} /><span /></label>
        <small role="status">{automationError ?? automation?.message ?? "Checking background automation…"}</small>
        {(automation?.state === "repair-needed" || (automation?.state === "unavailable" && automation.enabled)) && <Button size="sm" variant="tonal" disabled={automationBusy} onClick={() => void repairAutomation()}>{automationBusy ? "Repairing…" : "Repair"}</Button>}
      </section>
      {!ready ? <ErrorState title="Scheduled jobs are unavailable" description="Reconnect Railgun to view or change scheduled prompts." />
        : loading ? <LoadingState title="Loading scheduled jobs…" description="Reading scheduled prompts from Railgun." />
          : loadError !== undefined ? <div className="automation-state"><ErrorState title="Unable to load scheduled jobs" description={loadError} /><Button variant="tonal" onClick={() => void load()}>Retry</Button></div>
            : jobs.length === 0 ? <EmptyState title="No scheduled jobs yet" description="Create a scheduled prompt to let Railgun handle recurring work." />
              : <ol className="automation-list">{jobs.map(job => <li className="automation-row" key={job.id}>
                <span className="automation-icon" aria-hidden="true"><Clock /></span>
                <div className="automation-copy"><strong>{job.prompt}</strong><span>{job.summary}</span><code>{job.schedule}</code></div>
                <div className="automation-row-actions">
                  <Button variant="ghost" size="icon" aria-label={`Edit ${job.prompt}`} disabled={!ready || busy} onClick={() => openEditor(job)}><Pencil aria-hidden="true" /></Button>
                  <Button variant="ghost" size="icon" aria-label={`Delete ${job.prompt}`} disabled={!ready || busy} onClick={() => openDelete(job)}><Trash2 aria-hidden="true" /></Button>
                </div>
              </li>)}</ol>}
    </div>

    <Dialog open={editor !== undefined} onOpenChange={open => { if (!open && !busy) { setEditor(undefined); setMutationError(undefined); } }}>
      <DialogContent className="automation-dialog">
        <DialogHeader><DialogTitle>{editor?.job === undefined ? "Create scheduled job" : "Edit scheduled job"}</DialogTitle><DialogDescription>Use a local-time, five-field cron expression.</DialogDescription></DialogHeader>
        <label className="automation-field"><span>Prompt</span><Textarea aria-label="Prompt" maxLength={DESKTOP_CRON_LIMITS.prompt} value={editor?.prompt ?? ""} disabled={busy} aria-invalid={editor !== undefined && !promptValid} onChange={event => setEditor(current => current === undefined ? current : { ...current, prompt: event.target.value })} /></label>
        <label className="automation-field"><span>Schedule</span><Input className="automation-schedule-input" aria-label="Schedule" maxLength={DESKTOP_CRON_LIMITS.schedule} placeholder="0 9 * * 1-5" value={editor?.schedule ?? ""} disabled={busy} aria-invalid={editor !== undefined && !scheduleResult.valid} onChange={event => setEditor(current => current === undefined ? current : { ...current, schedule: event.target.value })} /></label>
        <div className={`automation-preview ${scheduleResult.valid ? "valid" : "invalid"}`} aria-live="polite">{scheduleResult.valid ? scheduleResult.summary : scheduleResult.error}</div>
        {mutationError === undefined ? null : <p className="automation-error" role="alert">{mutationError}</p>}
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setEditor(undefined)}>Cancel</Button><Button variant="tonal" disabled={!ready || busy || !editorValid} onClick={() => void save()}>{busy ? "Saving…" : editor?.job === undefined ? "Create" : "Save"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={deleting !== undefined} onOpenChange={open => { if (!open && !busy) { setDeleting(undefined); setMutationError(undefined); } }}>
      <DialogContent className="automation-dialog">
        <DialogHeader><DialogTitle>Delete scheduled job?</DialogTitle><DialogDescription>This permanently removes “{deleting?.prompt}”.</DialogDescription></DialogHeader>
        {mutationError === undefined ? null : <p className="automation-error" role="alert">{mutationError}</p>}
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setDeleting(undefined)}>Cancel</Button><Button variant="destructive" disabled={!ready || busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
};
