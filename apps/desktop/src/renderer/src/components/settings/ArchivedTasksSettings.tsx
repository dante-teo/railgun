import { ArchiveRestore, Search, Trash2 } from 'lucide-react'
import { useDeferredValue, useEffect, useState } from 'react'

import { InlineError, SettingsDetail, SettingsLoading, SettingsSection } from './SettingsChrome'
import { SettingsAnimatedList, SettingsCrossfade, SettingsListItem } from './SettingsMotion'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { ModelConfiguration } from '@/lib/model-api'
import type { ArchivedTaskSummary } from '@/lib/task-api'

interface Confirmation {
  action: 'unarchive' | 'delete'
  task: ArchivedTaskSummary
}

const archivedDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

function formatArchivedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : archivedDateFormatter.format(date)
}

export function ArchivedTasksSettings(): React.JSX.Element {
  const [tasks, setTasks] = useState<readonly ArchivedTaskSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [models, setModels] = useState<ModelConfiguration>()
  const [runStateError, setRunStateError] = useState<string>()
  const [mutationError, setMutationError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [deleteAllOpen, setDeleteAllOpen] = useState(false)
  const [reloadSequence, setReloadSequence] = useState(0)
  const [exitingTaskIds, setExitingTaskIds] = useState<ReadonlySet<string>>(new Set())
  const [taskMotionRevision, setTaskMotionRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    void window.railgun.tasks.listArchived().then(
      (records) => {
        if (!cancelled) {
          setTasks(records)
          setLoading(false)
        }
      },
      () => {
        if (!cancelled) {
          setLoadError('Could not load archived tasks.')
          setLoading(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [reloadSequence])

  useEffect(() => {
    let cancelled = false
    void window.railgun.models.get().then(
      (configuration) => {
        if (!cancelled) setModels(configuration)
      },
      () => {
        if (!cancelled)
          setRunStateError('Task run state is unavailable. Archive actions are locked.')
      }
    )
    return () => {
      cancelled = true
    }
  }, [reloadSequence])

  const retry = (): void => {
    setLoading(true)
    setLoadError(undefined)
    setRunStateError(undefined)
    setModels(undefined)
    setReloadSequence((current) => current + 1)
  }

  const actionsDisabled = busy || exitingTaskIds.size > 0 || !models || models.isRunning
  const visibleTasks = deferredQuery
    ? tasks.filter(({ title, model, id }) =>
        `${title} ${model} ${id}`.toLowerCase().includes(deferredQuery)
      )
    : tasks

  const confirmRowAction = async (): Promise<void> => {
    if (!confirmation || actionsDisabled) return
    setBusy(true)
    setMutationError(undefined)
    try {
      if (confirmation.action === 'unarchive') {
        await window.railgun.tasks.unarchive(confirmation.task.id)
      } else {
        await window.railgun.tasks.deleteArchived(confirmation.task.id)
      }
      const completedTaskId = confirmation.task.id
      setConfirmation(undefined)
      setExitingTaskIds((current) => new Set([...current, completedTaskId]))
    } catch {
      setMutationError(
        confirmation.action === 'unarchive'
          ? 'The task could not be unarchived. The list was not changed.'
          : 'The task could not be permanently deleted. The list was not changed.'
      )
    } finally {
      setBusy(false)
    }
  }

  const deleteAll = async (): Promise<void> => {
    if (actionsDisabled || tasks.length === 0) return
    setBusy(true)
    setMutationError(undefined)
    try {
      await window.railgun.tasks.deleteAllArchived()
      const visibleTaskIds = new Set(visibleTasks.map(({ id }) => id))
      setDeleteAllOpen(false)
      setTasks((current) => current.filter(({ id }) => visibleTaskIds.has(id)))
      setExitingTaskIds(visibleTaskIds)
    } catch {
      setMutationError('Archived tasks could not be deleted. The list was not changed.')
    } finally {
      setBusy(false)
    }
  }

  const finishTaskExit = (taskId: string): void => {
    setTasks((current) => current.filter(({ id }) => id !== taskId))
    setExitingTaskIds(
      (current) => new Set([...current].filter((currentId) => currentId !== taskId))
    )
    setTaskMotionRevision((current) => current + 1)
  }

  const presentationState = loading ? 'loading' : loadError ? 'error' : 'ready'

  return (
    <SettingsDetail
      description="Restore archived work or permanently remove it from local storage."
      title="Archived Tasks"
    >
      <SettingsSection
        action={
          <Button
            disabled={actionsDisabled || tasks.length === 0}
            onClick={() => setDeleteAllOpen(true)}
            size="sm"
            variant="destructive"
          >
            Delete All
          </Button>
        }
        description="Search by title, model, or task ID."
        title="Archive"
      >
        <FieldGroup>
          <Field>
            <FieldLabel className="sr-only" htmlFor="archived-task-search">
              Search archived tasks
            </FieldLabel>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                className="pl-8"
                disabled={exitingTaskIds.size > 0}
                id="archived-task-search"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search archived tasks"
                type="search"
                value={query}
              />
            </div>
          </Field>
        </FieldGroup>
        <InlineError>
          {models?.isRunning ? 'Archive actions are locked while a task runs.' : undefined}
        </InlineError>
        <InlineError>{runStateError}</InlineError>
        <InlineError>{mutationError}</InlineError>
        <SettingsCrossfade stateKey={presentationState}>
          {loading ? (
            <SettingsLoading label="Archived tasks are loading" />
          ) : loadError ? (
            <div className="flex items-center justify-between gap-3">
              <InlineError animatePresence={false}>{loadError}</InlineError>
              <Button onClick={retry} variant="outline">
                Retry
              </Button>
            </div>
          ) : visibleTasks.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {query ? 'No matching archived tasks' : 'No archived tasks'}
                </EmptyTitle>
                <EmptyDescription>
                  {query ? 'Try a title, model, or task ID.' : 'Archived tasks will appear here.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <SettingsAnimatedList ariaLabel="Archived tasks" motionRevision={taskMotionRevision}>
              {visibleTasks.map((task) => (
                <SettingsListItem
                  align="center"
                  exiting={exitingTaskIds.has(task.id)}
                  itemKey={task.id}
                  key={task.id}
                  onExitComplete={() => finishTaskExit(task.id)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{task.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline">{task.model}</Badge>
                      <span>
                        {task.messageCount} {task.messageCount === 1 ? 'message' : 'messages'}
                      </span>
                      <span>Archived {formatArchivedAt(task.archivedAt)}</span>
                      <span className="font-mono">{task.id}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      aria-label={`Unarchive ${task.title}`}
                      disabled={actionsDisabled}
                      onClick={() => setConfirmation({ action: 'unarchive', task })}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <ArchiveRestore />
                    </Button>
                    <Button
                      aria-label={`Permanently delete ${task.title}`}
                      disabled={actionsDisabled}
                      onClick={() => setConfirmation({ action: 'delete', task })}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </SettingsListItem>
              ))}
            </SettingsAnimatedList>
          )}
        </SettingsCrossfade>
      </SettingsSection>

      <AlertDialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => !open && setConfirmation(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation?.action === 'unarchive' ? 'Unarchive' : 'Permanently delete'} “
              {confirmation?.task.title}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.action === 'unarchive'
                ? 'The task will return to the Tasks list.'
                : 'Its messages and delivery records will be removed. This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={actionsDisabled}
              onClick={(event) => {
                event.preventDefault()
                void confirmRowAction()
              }}
              variant={confirmation?.action === 'delete' ? 'destructive' : 'default'}
            >
              {confirmation?.action === 'unarchive' ? 'Unarchive' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteAllOpen} onOpenChange={setDeleteAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete all {tasks.length} archived {tasks.length === 1 ? 'task' : 'tasks'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Only archived tasks will be purged. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={actionsDisabled}
              onClick={(event) => {
                event.preventDefault()
                void deleteAll()
              }}
              variant="destructive"
            >
              Delete All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsDetail>
  )
}
