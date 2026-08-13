import { useState, type FormEvent } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { usePresence } from '@/hooks/use-presence'
import {
  detectSchedulePreset,
  nextScheduleRun,
  normalizeCronSchedule,
  schedulePresets,
  type SchedulePreset
} from '@/lib/cron-schedule'
import type { ScheduledJob } from '@/lib/scheduler-api'

export interface ScheduledJobDraft {
  readonly name: string
  readonly schedule: string
  readonly prompt: string
}

const namePattern = /^[a-z0-9-]{1,64}$/u
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

const frequencyOptions: readonly { label: string; value: SchedulePreset }[] = [
  { label: 'Hourly', value: 'hourly' },
  { label: 'Daily at 9:00 AM', value: 'daily' },
  { label: 'Weekdays at 9:00 AM', value: 'weekdays' },
  { label: 'Custom', value: 'custom' }
]

function scheduleError(value: string): string | undefined {
  try {
    normalizeCronSchedule(value)
    return undefined
  } catch {
    return 'Enter a valid five-field cron expression.'
  }
}

function formatNextRun(schedule: string): { dateTime: string; label: string } | undefined {
  try {
    const nextRun = nextScheduleRun(schedule)
    return nextRun
      ? { dateTime: nextRun.toISOString(), label: dateTimeFormatter.format(nextRun) }
      : undefined
  } catch {
    return undefined
  }
}

export function ScheduledJobDialog({
  job,
  onOpenChange,
  onSave
}: {
  job?: ScheduledJob
  onOpenChange: (open: boolean) => void
  onSave: (draft: ScheduledJobDraft) => Promise<void>
}): React.JSX.Element {
  const initialPreset = job ? detectSchedulePreset(job.schedule) : 'daily'
  const [name, setName] = useState(job?.name ?? '')
  const [frequency, setFrequency] = useState<SchedulePreset>(initialPreset)
  const [schedule, setSchedule] = useState(job?.schedule ?? schedulePresets.daily)
  const [prompt, setPrompt] = useState(job?.prompt ?? '')
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [customFieldEntered, setCustomFieldEntered] = useState(false)

  const invalidName = !job && !namePattern.test(name)
  const invalidPrompt = !prompt.trim()
  const customScheduleVisible = frequency === 'custom'
  const customSchedulePresence = usePresence(customScheduleVisible)
  const customScheduleError = customScheduleVisible ? scheduleError(schedule) : undefined
  const nextRun = customScheduleVisible ? formatNextRun(schedule) : undefined

  const selectFrequency = (value: string): void => {
    const nextFrequency = value as SchedulePreset
    setFrequency(nextFrequency)
    if (nextFrequency === 'custom') setCustomFieldEntered(false)
    if (nextFrequency !== 'custom') setSchedule(schedulePresets[nextFrequency])
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSubmitted(true)
    setSaveError(undefined)
    if (invalidName || invalidPrompt || customScheduleError) return

    setSaving(true)
    try {
      await onSave({
        name: job?.name ?? name,
        schedule: normalizeCronSchedule(schedule),
        prompt: prompt.trim()
      })
    } catch {
      setSaveError(
        job
          ? 'The schedule could not be updated. Your changes are still here.'
          : 'The schedule could not be created. Your draft is still here.'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!saving) onOpenChange(open)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <form className="contents" noValidate onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{job ? `Edit ${job.name}` : 'New Schedule'}</DialogTitle>
            <DialogDescription>
              Railgun evaluates schedules in your Mac’s current local time.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field data-disabled={job ? true : undefined} data-invalid={submitted && invalidName}>
              <FieldLabel htmlFor="scheduled-job-name">Name</FieldLabel>
              <Input
                aria-invalid={submitted && invalidName}
                autoComplete="off"
                disabled={Boolean(job)}
                id="scheduled-job-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="morning-brief"
                required
                value={name}
              />
              {job ? (
                <FieldDescription>Names cannot be changed after creation.</FieldDescription>
              ) : submitted && invalidName ? (
                <FieldError>Use 1–64 lowercase letters, numbers, or hyphens.</FieldError>
              ) : (
                <FieldDescription>Use lowercase letters, numbers, and hyphens.</FieldDescription>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="scheduled-job-frequency">Frequency</FieldLabel>
              <Select onValueChange={selectFrequency} value={frequency}>
                <SelectTrigger aria-label="Frequency" id="scheduled-job-frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectGroup>
                    {frequencyOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {customSchedulePresence.mounted ? (
              <Field
                aria-hidden={customScheduleVisible ? undefined : 'true'}
                className="translate-y-0 opacity-100 transition-[opacity,translate] duration-(--duration-feedback) ease-(--ease-out) starting:data-[motion=entering]:-translate-y-1 starting:data-[motion=entering]:opacity-0 data-[motion=exiting]:pointer-events-none data-[motion=exiting]:-translate-y-1 data-[motion=exiting]:opacity-0 motion-reduce:translate-none! motion-reduce:transition-opacity! motion-reduce:duration-(--duration-feedback)! motion-reduce:starting:data-[motion=entering]:opacity-[0.92] motion-reduce:data-[motion=exiting]:opacity-[0.92]"
                data-invalid={Boolean(customScheduleError)}
                data-motion={
                  customScheduleVisible ? (customFieldEntered ? 'stable' : 'entering') : 'exiting'
                }
                data-slot="scheduled-custom-field"
                inert={customScheduleVisible ? undefined : true}
                onTransitionEnd={(event) => {
                  customSchedulePresence.handleTransitionEnd(event)
                  if (
                    customScheduleVisible &&
                    event.target === event.currentTarget &&
                    event.propertyName === 'opacity'
                  ) {
                    setCustomFieldEntered(true)
                  }
                }}
              >
                <FieldLabel htmlFor="scheduled-job-cron">Cron expression</FieldLabel>
                <Input
                  aria-invalid={Boolean(customScheduleError)}
                  autoComplete="off"
                  id="scheduled-job-cron"
                  onChange={(event) => setSchedule(event.target.value)}
                  placeholder="0 9 * * 1-5"
                  required
                  value={schedule}
                />
                {customScheduleError ? (
                  <FieldError>{customScheduleError}</FieldError>
                ) : (
                  <FieldDescription>
                    Five fields: minute, hour, day, month, weekday. Uses your Mac’s local time.
                    {nextRun ? (
                      <>
                        {' '}
                        Next due: <time dateTime={nextRun.dateTime}>{nextRun.label}</time>.
                      </>
                    ) : null}
                  </FieldDescription>
                )}
              </Field>
            ) : null}

            <Field data-invalid={submitted && invalidPrompt}>
              <FieldLabel htmlFor="scheduled-job-prompt">Prompt</FieldLabel>
              <Textarea
                aria-invalid={submitted && invalidPrompt}
                id="scheduled-job-prompt"
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe what Railgun should do when this schedule is due."
                required
                rows={5}
                value={prompt}
              />
              {submitted && invalidPrompt ? (
                <FieldError>Enter a prompt for this schedule.</FieldError>
              ) : (
                <FieldDescription>Railgun starts a new task with this prompt.</FieldDescription>
              )}
            </Field>
          </FieldGroup>

          {saveError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not save schedule</AlertTitle>
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              disabled={saving}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? 'Saving…' : job ? 'Save changes' : 'Create schedule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
