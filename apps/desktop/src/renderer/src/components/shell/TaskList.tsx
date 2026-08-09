import { useState } from 'react'
import { Archive } from 'lucide-react'

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
  archiveError?: string
  loadError?: string
  loading: boolean
  onArchive: (sessionId: string) => void
  onArchiveExit: (sessionId: string) => void
  onSelect: (sessionId: string) => void
  restoredTaskId?: string
  selectedTaskId?: string
  tasks: readonly TaskSummary[]
}

interface TaskListRowProps {
  archiving: boolean
  archiveDisabled: boolean
  onArchive: (sessionId: string) => void
  onArchiveExit: (sessionId: string) => void
  onSelect: (sessionId: string) => void
  restored: boolean
  selected: boolean
  task: TaskSummary
}

function isOwnOpacityTransition(event: React.TransitionEvent<HTMLElement>): boolean {
  return event.target === event.currentTarget && event.propertyName === 'opacity'
}

function TaskListRow({
  archiving,
  archiveDisabled,
  onArchive,
  onArchiveExit,
  onSelect,
  restored,
  selected,
  task
}: TaskListRowProps): React.JSX.Element {
  const archiveLabel = `Archive ${task.title}`
  const finishArchiveTransition = (event: React.TransitionEvent<HTMLLIElement>): void => {
    if (archiving && isOwnOpacityTransition(event)) {
      onArchiveExit(task.id)
    }
  }

  return (
    <li
      aria-hidden={archiving || undefined}
      className={cn(
        'group flex min-h-15 items-center gap-1 rounded-md pr-2 transition-[background-color,opacity,transform] duration-(--duration-feedback) ease-(--ease-out) hover:bg-muted focus-within:bg-muted data-[archiving=true]:pointer-events-none data-[archiving=true]:translate-x-1 data-[archiving=true]:opacity-0 data-[restored=true]:animate-in data-[restored=true]:fade-in-0 data-[restored=true]:slide-in-from-right-1 data-[restored=true]:duration-(--duration-feedback)',
        selected && 'bg-muted'
      )}
      data-archiving={archiving || undefined}
      data-restored={restored || undefined}
      data-slot="task-list-row"
      onTransitionEnd={finishArchiveTransition}
    >
      <Button
        aria-label={`Select ${task.title}`}
        aria-pressed={selected}
        className="h-auto min-w-0 flex-1 justify-start px-3 py-2 text-left"
        disabled={archiving}
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
    <div aria-label="Task list is loading" className="flex flex-col gap-1" role="status">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="flex min-h-15 items-center gap-3 px-3 py-2" key={index}>
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

export function TaskList({
  archivingTaskId,
  archiveDisabled,
  archiveError,
  loadError,
  loading,
  onArchive,
  onArchiveExit,
  onSelect,
  restoredTaskId,
  selectedTaskId,
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
      {archiveError ? (
        <p
          className="animate-in px-3 pb-2 text-xs leading-5 text-destructive fade-in-0 slide-in-from-top-1 duration-(--duration-feedback) ease-(--ease-out)"
          data-slot="task-list-error"
          role="alert"
        >
          {archiveError}
        </p>
      ) : null}
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
              <ol className="flex min-w-0 flex-col gap-1">
                {tasks.map((task) => (
                  <TaskListRow
                    archiving={task.id === archivingTaskId}
                    archiveDisabled={archiveDisabled}
                    key={task.id}
                    onArchive={onArchive}
                    onArchiveExit={onArchiveExit}
                    onSelect={onSelect}
                    restored={task.id === restoredTaskId}
                    selected={task.id === selectedTaskId}
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
