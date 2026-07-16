import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, Pencil, Plus, Trash2 } from "lucide-react";
import { parseCronSchedule } from "../../shared/cron";
import { DESKTOP_CRON_LIMITS } from "../../shared/schemas";
import type { BackendPhase, CronJob, CronJobInput } from "../../shared/types";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input, Textarea } from "../components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { PageLayout } from "../components/layouts";
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

  return <PageLayout className="relative">
    <header className="content-toolbar relative z-[var(--layer-titlebar-control)] flex min-h-[var(--toolbar-surface-height)] w-full items-start bg-transparent pb-2 pt-[calc(var(--titlebar-control-center-y)_-_0.875rem)]">
      <div className="ml-[var(--toolbar-content-left)] transition-[margin-left] duration-standard ease-standard"><h1 className="m-0 text-[0.9375rem] font-semibold tracking-[-0.01em]">Scheduled</h1><p className="mb-0 mt-0.5 text-caption text-foreground-secondary">Scheduled prompts run in your local timezone.</p></div>
      <div className="content-toolbar-actions absolute right-[calc(var(--toolbar-surface-right)+var(--space-7))] top-[var(--titlebar-control-center-y)] z-[var(--layer-titlebar-action)] flex -translate-y-1/2 items-center gap-2 [-webkit-app-region:no-drag]"><Button size="icon" variant="ghost" className="[-webkit-app-region:no-drag]" aria-label="Create scheduled job" disabled={!ready || busy} onClick={() => openEditor()}><Plus aria-hidden="true" /></Button></div>
    </header>
    <div className="min-h-0 overflow-auto px-7 pb-8 pt-5 [&>*]:mx-auto [&>*]:w-[min(50rem,100%)]">
      {!ready ? <ErrorState title="Scheduled jobs are unavailable" description="Reconnect Railgun to view or change scheduled prompts." />
        : loading ? <LoadingState title="Loading scheduled jobs…" description="Reading scheduled prompts from Railgun." />
          : loadError !== undefined ? <div className="grid justify-items-center gap-3"><ErrorState title="Unable to load scheduled jobs" description={loadError} /><Button variant="secondary" onClick={() => void load()}>Retry</Button></div>
            : jobs.length === 0 ? <EmptyState title="No scheduled jobs yet" description="Create a scheduled prompt to let Railgun handle recurring work." />
              : <ol className="grid list-none gap-3 p-0">{jobs.map(job => <li className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border bg-surface p-4" key={job.id}>
                <span className="grid size-9 place-items-center rounded-sm bg-accent text-accent-foreground [&_svg]:size-[1.1rem]" aria-hidden="true"><Clock /></span>
                <div className="grid min-w-0 gap-1"><strong className="truncate text-body font-medium">{job.prompt}</strong><span className="text-control text-foreground-secondary">{job.summary}</span><code className="w-fit rounded-[0.3rem] bg-surface-muted px-1 py-0.5 text-caption text-foreground-secondary">{job.schedule}</code></div>
                <div className="flex gap-1">
                  <Button className="size-8 text-foreground-secondary hover:text-foreground" variant="ghost" size="icon" aria-label={`Edit ${job.prompt}`} disabled={!ready || busy} onClick={() => openEditor(job)}><Pencil aria-hidden="true" /></Button>
                  <Button className="size-8 text-foreground-secondary hover:text-foreground" variant="ghost" size="icon" aria-label={`Delete ${job.prompt}`} disabled={!ready || busy} onClick={() => openDelete(job)}><Trash2 aria-hidden="true" /></Button>
                </div>
              </li>)}</ol>}
    </div>

    <Dialog open={editor !== undefined} onOpenChange={open => { if (!open && !busy) { setEditor(undefined); setMutationError(undefined); } }}>
      <DialogContent className="w-[min(32rem,calc(100vw_-_2rem))]">
        <DialogHeader><DialogTitle>{editor?.job === undefined ? "Create scheduled job" : "Edit scheduled job"}</DialogTitle><DialogDescription>Use a local-time, five-field cron expression.</DialogDescription></DialogHeader>
        <label className="mt-4 grid gap-2 text-control text-foreground-secondary"><span>Prompt</span><Textarea aria-label="Prompt" maxLength={DESKTOP_CRON_LIMITS.prompt} value={editor?.prompt ?? ""} disabled={busy} aria-invalid={editor !== undefined && !promptValid} onChange={event => setEditor(current => current === undefined ? current : { ...current, prompt: event.target.value })} /></label>
        <label className="mt-4 grid gap-2 text-control text-foreground-secondary"><span>Schedule</span><Input className="font-mono" aria-label="Schedule" maxLength={DESKTOP_CRON_LIMITS.schedule} placeholder="0 9 * * 1-5" value={editor?.schedule ?? ""} disabled={busy} aria-invalid={editor !== undefined && !scheduleResult.valid} onChange={event => setEditor(current => current === undefined ? current : { ...current, schedule: event.target.value })} /></label>
        <div className={scheduleResult.valid ? "mt-2 min-h-6 pt-1 text-control leading-snug text-accent-foreground" : "mt-2 min-h-6 pt-1 text-control leading-snug text-foreground-secondary"} aria-live="polite">{scheduleResult.valid ? scheduleResult.summary : scheduleResult.error}</div>
        {mutationError === undefined ? null : <p className="m-0 text-control text-destructive" role="alert">{mutationError}</p>}
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setEditor(undefined)}>Cancel</Button><Button variant="secondary" disabled={!ready || busy || !editorValid} onClick={() => void save()}>{busy ? "Saving…" : editor?.job === undefined ? "Create" : "Save"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      open={deleting !== undefined}
      title="Delete scheduled job?"
      description={<>This permanently removes “{deleting?.prompt}”.</>}
      confirmLabel="Delete"
      busyLabel="Deleting…"
      busy={busy}
      confirmDisabled={!ready}
      destructive
      error={mutationError}
      contentClassName="w-[min(32rem,calc(100vw_-_2rem))]"
      onOpenChange={open => { if (!open) { setDeleting(undefined); setMutationError(undefined); } }}
      onConfirm={() => void remove()}
    />
  </PageLayout>;
};
