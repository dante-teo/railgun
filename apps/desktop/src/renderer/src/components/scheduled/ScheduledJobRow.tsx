import { Pencil, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePresence } from '@/hooks/use-presence'
import { detectSchedulePreset, nextScheduleRun } from '@/lib/cron-schedule'
import type { ScheduledJob } from '@/lib/scheduler-api'

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

const presetLabels = {
  hourly: 'Hourly',
  daily: 'Daily at 9:00 AM',
  weekdays: 'Weekdays at 9:00 AM',
  custom: 'Custom'
} as const

function formattedTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeFormatter.format(date)
}

function statusPresentation(job: ScheduledJob): {
  label: string
  variant: React.ComponentProps<typeof Badge>['variant']
} {
  if (!job.lastRunAt) return { label: 'Never run', variant: 'outline' }
  if (job.lastStatus === 'completed') return { label: 'Completed', variant: 'secondary' }
  if (job.lastStatus === 'failed') return { label: 'Failed', variant: 'destructive' }
  return { label: 'Run recorded', variant: 'outline' }
}

export function ScheduledJobRow({
  entering,
  exiting,
  job,
  onDelete,
  onEdit,
  onEnterComplete,
  onExitComplete
}: {
  entering: boolean
  exiting: boolean
  job: ScheduledJob
  onDelete: () => void
  onEdit: () => void
  onEnterComplete: () => void
  onExitComplete: () => void
}): React.JSX.Element | null {
  const presence = usePresence(!exiting, onExitComplete)
  if (!presence.mounted) return null

  const nextRun = nextScheduleRun(job.schedule)
  const preset = detectSchedulePreset(job.schedule)
  const status = statusPresentation(job)

  return (
    <li
      aria-hidden={exiting ? 'true' : undefined}
      className="grid scale-100 grid-cols-[minmax(0,1.25fr)_minmax(12rem,0.75fr)_minmax(15rem,0.9fr)_auto] items-start gap-6 rounded-xl border bg-card p-4 opacity-100 shadow-minimal transition-[opacity,transform] duration-(--duration-feedback) ease-(--ease-out) starting:data-[motion=entering]:scale-[0.98] starting:data-[motion=entering]:opacity-0 data-[motion=exiting]:pointer-events-none data-[motion=exiting]:scale-[0.98] data-[motion=exiting]:opacity-0 motion-reduce:transform-none! motion-reduce:transition-opacity! motion-reduce:duration-(--duration-feedback)! motion-reduce:starting:data-[motion=entering]:opacity-[0.92] motion-reduce:data-[motion=exiting]:opacity-[0.92]"
      data-motion={exiting ? 'exiting' : entering ? 'entering' : 'stable'}
      data-slot="scheduled-job-row"
      inert={exiting || undefined}
      onTransitionEnd={(event) => {
        presence.handleTransitionEnd(event)
        if (entering && event.target === event.currentTarget && event.propertyName === 'opacity') {
          onEnterComplete()
        }
      }}
    >
      <div className="min-w-0">
        <p className="truncate font-mono text-sm font-medium">{job.name}</p>
        <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
          {job.prompt}
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-sm font-medium">{presetLabels[preset]}</span>
        <code className="truncate font-mono text-xs text-muted-foreground">{job.schedule}</code>
      </div>

      <div className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Badge variant={status.variant}>{status.label}</Badge>
          {job.lastRunAt ? (
            <span>
              Last run <time dateTime={job.lastRunAt}>{formattedTime(job.lastRunAt)}</time>
            </span>
          ) : (
            <span>No runs yet</span>
          )}
        </div>
        <span>
          Next due{' '}
          {nextRun ? (
            <time dateTime={nextRun.toISOString()}>{formattedTime(nextRun)}</time>
          ) : (
            'is not available'
          )}
        </span>
        {job.lastStatus === 'failed' && job.lastError ? (
          <p className="line-clamp-2 text-destructive">{job.lastError}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button aria-label={`Edit ${job.name}`} onClick={onEdit} size="icon-sm" variant="ghost">
              <Pencil />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit schedule</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={`Delete ${job.name}`}
              onClick={onDelete}
              size="icon-sm"
              variant="ghost"
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete schedule</TooltipContent>
        </Tooltip>
      </div>
    </li>
  )
}
