import { useState } from 'react'
import { Archive } from 'lucide-react'

import { usePresence } from '@/hooks/use-presence'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatFullTaskTimestamp, formatTaskDate } from '@/lib/format-task-date'
import type { TaskSummary } from '@/lib/task-api'
import { cn } from '@/lib/utils'

export interface TaskListProps {
  archivingTaskId?: string
  archiveDisabled: boolean
  loadError?: string
  loading: boolean
  newlyPersistedTaskId?: string
  onArchive: (sessionId: string) => void
  onArchiveExit: (sessionId: string) => void
  onNewlyPersistedEntranceComplete?: (sessionId: string) => void
  onSelect: (sessionId: string) => void
  restoredTaskId?: string
  selectionDisabled?: boolean
  selectedTaskId?: string
  taskActionError?: string
  tasks: readonly TaskSummary[]
}

interface TaskListRowProps {
  archiving: boolean
  archiveDisabled: boolean
  newlyPersisted: boolean
  onArchive: (sessionId: string) => void
  onArchiveExit: (sessionId: string) => void
  onNewlyPersistedEntranceComplete?: (sessionId: string) => void
  onSelect: (sessionId: string) => void
  restored: boolean
  selected: boolean
  selectionDisabled: boolean
  task: TaskSummary
}

function isOwnOpacityTransition(event: React.TransitionEvent<HTMLElement>): boolean {
  return event.target === event.currentTarget && event.propertyName === 'opacity'
}

function TaskListRow({
  archiving,
  archiveDisabled,
  newlyPersisted,
  onArchive,
  onArchiveExit,
  onNewlyPersistedEntranceComplete,
  onSelect,
  restored,
  selected,
  selectionDisabled,
  task
}: TaskListRowProps): React.JSX.Element {
  const archiveLabel = `Archive ${task.title}`
  const finishRowTransition = (event: React.TransitionEvent<HTMLLIElement>): void => {
    if (!isOwnOpacityTransition(event)) {
      return
    }
    if (archiving) {
      onArchiveExit(task.id)
    }
    if (newlyPersisted) {
      onNewlyPersistedEntranceComplete?.(task.id)
    }
  }

  return (
    <li
      aria-hidden={archiving || undefined}
      className={cn(
        'group flex min-h-15 items-center gap-2 rounded-md pr-2 transition-[background-color,opacity,transform] duration-(--duration-feedback) ease-(--ease-out) starting:data-[newly-persisted=true]:translate-x-1 starting:data-[newly-persisted=true]:opacity-0 motion-reduce:translate-x-0! data-[archiving=true]:pointer-events-none data-[archiving=true]:translate-x-1 data-[archiving=true]:opacity-0 data-[restored=true]:animate-in data-[restored=true]:fade-in-0 data-[restored=true]:slide-in-from-right-1 data-[restored=true]:duration-(--duration-feedback)',
        selected
          ? 'bg-surface-active hover:bg-surface-active focus-within:bg-surface-active'
          : 'hover:bg-muted focus-within:bg-muted'
      )}
      data-archiving={archiving || undefined}
      data-newly-persisted={newlyPersisted || undefined}
      data-restored={restored || undefined}
      data-slot="task-list-row"
      onTransitionEnd={finishRowTransition}
    >
      <Button
        aria-label={`Select ${task.title}`}
        aria-pressed={selected}
        className="h-auto min-w-0 flex-1 justify-start px-3 py-2 text-left"
        disabled={archiving || selectionDisabled}
        onClick={() => onSelect(task.id)}
        type="button"
        variant="ghost"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-5" title={task.title}>
            {task.title}
          </span>
          <time
            className="block truncate text-xs leading-5 text-muted-foreground"
            dateTime={task.lastMessageAt}
            title={formatFullTaskTimestamp(task.lastMessageAt)}
          >
            {formatTaskDate(task.lastMessageAt)}
          </time>
        </span>
      </Button>
      <div className="flex size-7 shrink-0 items-center justify-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={archiveLabel}
              className="opacity-0 transition-opacity duration-(--duration-feedback) ease-(--ease-out) group-hover:opacity-100 group-focus-within:duration-0 group-focus-within:opacity-100 focus-visible:duration-0 focus-visible:opacity-100"
              disabled={archiveDisabled || archiving}
              onClick={() => onArchive(task.id)}
              size="icon-sm"
              type="button"
              variant="rowAction"
            >
              <Archive aria-hidden="true" data-icon="inline-start" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{archiveLabel}</TooltipContent>
        </Tooltip>
      </div>
    </li>
  )
}

function TaskListSkeleton({ active }: { active: boolean }): React.JSX.Element {
  return (
    <div aria-label="Task list is loading" className="flex flex-col gap-2" role="status">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="flex min-h-15 items-center gap-2 px-3 py-2" key={index}>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className={cn('h-4 w-4/5', !active && 'animate-none')} />
            <Skeleton className={cn('h-3 w-20', !active && 'animate-none')} />
          </div>
          <div className="size-7 shrink-0" />
        </div>
      ))}
    </div>
  )
}

function TaskListEmpty({ loadError }: Pick<TaskListProps, 'loadError'>): React.JSX.Element {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{loadError ? 'Tasks unavailable' : 'No tasks yet'}</EmptyTitle>
        <EmptyDescription role={loadError ? 'alert' : undefined}>
          {loadError ?? 'Your saved conversations will appear here.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function TaskListActionError({ error }: { error?: string }): React.JSX.Element | null {
  const present = Boolean(error)
  const [content, setContent] = useState({ message: error, source: error })
  const { mounted, handleTransitionEnd } = usePresence(present)
  if (content.source !== error) {
    setContent({ message: error ?? content.message, source: error })
  }

  if (!mounted || !content.message) {
    return null
  }

  return (
    <p
      aria-hidden={present ? undefined : true}
      className="translate-y-0 px-3 pb-2 text-xs leading-5 text-destructive opacity-100 transition-[opacity,transform] duration-(--duration-feedback) ease-(--ease-out) starting:-translate-y-1 starting:opacity-0 data-[present=false]:pointer-events-none data-[present=false]:-translate-y-1 data-[present=false]:opacity-0 data-[present=false]:duration-100 motion-reduce:transform-none! motion-reduce:transition-opacity! motion-reduce:duration-(--duration-feedback)!"
      data-present={present}
      data-slot="task-list-error"
      inert={present ? undefined : true}
      onTransitionEnd={handleTransitionEnd}
      role={present ? 'alert' : undefined}
    >
      {content.message}
    </p>
  )
}

export function TaskList({
  archivingTaskId,
  archiveDisabled,
  loadError,
  loading,
  newlyPersistedTaskId,
  onArchive,
  onArchiveExit,
  onNewlyPersistedEntranceComplete,
  onSelect,
  restoredTaskId,
  selectionDisabled = false,
  selectedTaskId,
  taskActionError,
  tasks
}: TaskListProps): React.JSX.Element {
  const [showLoadingSurface, setShowLoadingSurface] = useState(loading)
  const finishLoadingTransition = (event: React.TransitionEvent<HTMLDivElement>): void => {
    if (!loading && isOwnOpacityTransition(event)) {
      setShowLoadingSurface(false)
    }
  }

  return (
    <section
      aria-busy={loading}
      aria-label="Task list"
      className="flex h-full min-w-0 flex-col overflow-hidden px-3 py-3"
    >
      <TaskListActionError error={taskActionError} />
      <div className="grid min-h-0 flex-1">
        {showLoadingSurface ? (
          <div
            aria-hidden={!loading || undefined}
            className="col-start-1 row-start-1 min-h-0 translate-y-1 opacity-0 transition-[opacity,transform] duration-(--duration-feedback) ease-(--ease-out) data-[visible=true]:translate-y-0 data-[visible=true]:opacity-100 aria-hidden:pointer-events-none"
            data-slot="task-list-state"
            data-visible={loading}
            onTransitionEnd={finishLoadingTransition}
          >
            <TaskListSkeleton active={loading} />
          </div>
        ) : null}
        {!loading ? (
          <div
            className="col-start-1 row-start-1 min-h-0 overflow-y-auto animate-in fade-in-0 slide-in-from-bottom-1 duration-(--duration-feedback) ease-(--ease-out)"
            data-slot="task-list-state"
          >
            {tasks.length === 0 ? (
              <TaskListEmpty loadError={loadError} />
            ) : (
              <ol className="flex min-w-0 flex-col gap-2">
                {tasks.map((task) => (
                  <TaskListRow
                    archiving={task.id === archivingTaskId}
                    archiveDisabled={archiveDisabled}
                    key={task.id}
                    newlyPersisted={task.id === newlyPersistedTaskId}
                    onArchive={onArchive}
                    onArchiveExit={onArchiveExit}
                    onNewlyPersistedEntranceComplete={onNewlyPersistedEntranceComplete}
                    onSelect={onSelect}
                    restored={task.id === restoredTaskId}
                    selected={task.id === selectedTaskId}
                    selectionDisabled={selectionDisabled}
                    task={task}
                  />
                ))}
              </ol>
            )}
          </div>
        ) : null}
      </div>
    </section>
  )
}
