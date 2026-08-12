import { CalendarClock, Plus, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'

import { ScheduledJobDialog, type ScheduledJobDraft } from './ScheduledJobDialog'
import { ScheduledJobRow } from './ScheduledJobRow'
import { Crossfade } from '@/components/motion/Crossfade'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import type { ScheduledJob, SchedulerStatus } from '@/lib/scheduler-api'

const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base' })
const jobsRefreshIntervalMilliseconds = 30_000

function ScheduledJobsLoading(): React.JSX.Element {
  return (
    <div aria-label="Scheduled jobs are loading" className="flex flex-col gap-3" role="status">
      {[0, 1, 2].map((index) => (
        <div
          className="grid grid-cols-[minmax(0,1.25fr)_minmax(12rem,0.75fr)_minmax(15rem,0.9fr)_auto] gap-6 rounded-xl border p-4"
          key={index}
        >
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-full" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="size-7" />
        </div>
      ))}
    </div>
  )
}

function SchedulerNotice({
  error,
  onRetry,
  status
}: {
  error?: string
  onRetry: () => void
  status?: SchedulerStatus
}): React.JSX.Element | null {
  if (error) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Background scheduling status is unavailable</AlertTitle>
        <AlertDescription>
          Schedules can still be managed, but Railgun could not check whether they will run.
        </AlertDescription>
        <AlertAction>
          <Button onClick={onRetry} size="sm" variant="outline">
            Retry status
          </Button>
        </AlertAction>
      </Alert>
    )
  }
  if (!status || status.state === 'running') return null

  return (
    <Alert>
      <TriangleAlert />
      <AlertTitle>Background scheduling is not running</AlertTitle>
      <AlertDescription>
        {status.detail ??
          'These schedules remain editable, but they will not run until Background Scheduling is available.'}{' '}
        <Link to="/settings/general">Open General Settings</Link>.
      </AlertDescription>
    </Alert>
  )
}

export function ScheduledJobsWorkspace(): React.JSX.Element {
  const [jobs, setJobs] = useState<readonly ScheduledJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [jobsError, setJobsError] = useState<string>()
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus>()
  const [schedulerStatusError, setSchedulerStatusError] = useState<string>()
  const [schedulerStatusRevision, setSchedulerStatusRevision] = useState(0)
  const [editingJob, setEditingJob] = useState<ScheduledJob | null | undefined>(undefined)
  const [deletingJob, setDeletingJob] = useState<ScheduledJob>()
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()
  const [enteringName, setEnteringName] = useState<string>()
  const [exitingNames, setExitingNames] = useState<ReadonlySet<string>>(new Set())
  const jobsRequest = useRef(0)
  const jobsRequestInFlight = useRef(false)
  const jobsMutationInFlight = useRef(false)

  const requestJobs = useCallback((reportErrors: boolean): void => {
    if (jobsMutationInFlight.current || jobsRequestInFlight.current) return
    const request = ++jobsRequest.current
    jobsRequestInFlight.current = true
    void window.railgun.scheduler
      .listJobs()
      .then(
        (records) => {
          if (request !== jobsRequest.current) return
          setJobs(records)
          setJobsError(undefined)
          setJobsLoading(false)
        },
        () => {
          if (request !== jobsRequest.current) return
          if (reportErrors) {
            setJobsError('Could not load scheduled jobs')
            setJobsLoading(false)
          }
        }
      )
      .finally(() => {
        jobsRequestInFlight.current = false
      })
  }, [])

  useEffect(() => {
    requestJobs(true)
    const interval = window.setInterval(() => requestJobs(false), jobsRefreshIntervalMilliseconds)
    return () => {
      jobsRequest.current += 1
      window.clearInterval(interval)
    }
  }, [requestJobs])

  useEffect(() => {
    let cancelled = false
    void window.railgun.scheduler.getStatus().then(
      (status) => {
        if (cancelled) return
        setSchedulerStatus(status)
        setSchedulerStatusError(undefined)
      },
      () => {
        if (cancelled) return
        setSchedulerStatus(undefined)
        setSchedulerStatusError('Could not check Background Scheduling')
      }
    )
    return () => {
      cancelled = true
    }
  }, [schedulerStatusRevision])

  const sortedJobs = useMemo(
    () => jobs.toSorted((left, right) => nameCollator.compare(left.name, right.name)),
    [jobs]
  )

  const retryJobs = (): void => {
    setJobsLoading(true)
    setJobsError(undefined)
    requestJobs(true)
  }

  const retryStatus = (): void => {
    setSchedulerStatusError(undefined)
    setSchedulerStatusRevision((current) => current + 1)
  }

  const saveJob = async (draft: ScheduledJobDraft): Promise<void> => {
    const creatingInVisibleList = editingJob === null && jobs.length > 0
    jobsMutationInFlight.current = true
    jobsRequest.current += 1
    try {
      const saved = editingJob
        ? await window.railgun.scheduler.updateJob(editingJob.name, {
            schedule: draft.schedule,
            prompt: draft.prompt
          })
        : await window.railgun.scheduler.createJob(draft)
      setJobs((current) =>
        editingJob
          ? current.map((record) => (record.name === saved.name ? saved : record))
          : [...current, saved]
      )
      setEnteringName(creatingInVisibleList ? saved.name : undefined)
      setEditingJob(undefined)
    } finally {
      jobsMutationInFlight.current = false
    }
  }

  const deleteConfirmedJob = async (): Promise<void> => {
    if (!deletingJob || deleteBusy) return
    let exiting = false
    jobsMutationInFlight.current = true
    jobsRequest.current += 1
    setDeleteBusy(true)
    setDeleteError(undefined)
    try {
      await window.railgun.scheduler.deleteJob(deletingJob.name)
      const deletedName = deletingJob.name
      setDeletingJob(undefined)
      setExitingNames((current) => new Set([...current, deletedName]))
      exiting = true
    } catch {
      setDeleteError('The schedule could not be deleted. The list was not changed.')
    } finally {
      if (!exiting) jobsMutationInFlight.current = false
      setDeleteBusy(false)
    }
  }

  const finishExit = (name: string): void => {
    setJobs((current) => current.filter((record) => record.name !== name))
    setExitingNames(
      (current) => new Set([...current].filter((currentName) => currentName !== name))
    )
    jobsMutationInFlight.current = false
  }

  const presentationState = jobsLoading
    ? 'loading'
    : jobsError
      ? 'error'
      : sortedJobs.length === 0
        ? 'empty'
        : 'ready'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 py-8">
        <div className="flex items-start justify-between gap-6">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-2xl font-semibold leading-tight tracking-tight">Scheduled Jobs</h1>
            <p className="text-sm text-muted-foreground">
              Run recurring prompts automatically in your Mac’s local time.
            </p>
          </div>
          <Button onClick={() => setEditingJob(null)}>
            <Plus data-icon="inline-start" />
            New Schedule
          </Button>
        </div>

        <SchedulerNotice
          error={schedulerStatusError}
          onRetry={retryStatus}
          status={schedulerStatus}
        />

        <Crossfade stateKey={presentationState}>
          {jobsLoading ? (
            <ScheduledJobsLoading />
          ) : jobsError ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>{jobsError}</AlertTitle>
              <AlertDescription>
                Railgun could not read the schedule store. Existing schedules were not changed.
              </AlertDescription>
              <AlertAction>
                <Button onClick={retryJobs} size="sm" variant="outline">
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : sortedJobs.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CalendarClock />
                </EmptyMedia>
                <EmptyTitle>No schedules yet</EmptyTitle>
                <EmptyDescription>
                  Create a recurring prompt for work Railgun should start automatically.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => setEditingJob(null)}>
                  <Plus data-icon="inline-start" />
                  New Schedule
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <ul aria-label="Scheduled jobs" className="flex flex-col gap-3">
              {sortedJobs.map((record) => (
                <ScheduledJobRow
                  entering={enteringName === record.name}
                  exiting={exitingNames.has(record.name)}
                  job={record}
                  key={record.name}
                  onDelete={() => {
                    setDeleteError(undefined)
                    setDeletingJob(record)
                  }}
                  onEdit={() => setEditingJob(record)}
                  onEnterComplete={() => {
                    setEnteringName((current) => (current === record.name ? undefined : current))
                  }}
                  onExitComplete={() => finishExit(record.name)}
                />
              ))}
            </ul>
          )}
        </Crossfade>
      </div>

      {editingJob !== undefined ? (
        <ScheduledJobDialog
          job={editingJob ?? undefined}
          onOpenChange={(open) => {
            if (!open) setEditingJob(undefined)
          }}
          onSave={saveJob}
        />
      ) : null}

      <AlertDialog
        open={Boolean(deletingJob)}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) {
            setDeletingJob(undefined)
            setDeleteError(undefined)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deletingJob?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This schedule will stop creating new tasks. Existing tasks are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not delete schedule</AlertTitle>
              <AlertDescription>{deleteError}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteBusy}
              onClick={(event) => {
                event.preventDefault()
                void deleteConfirmedJob()
              }}
              variant="destructive"
            >
              {deleteBusy ? 'Deleting…' : 'Delete schedule'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
