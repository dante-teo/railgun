import { MessageSquareText, MousePointer2, Sparkles } from 'lucide-react'

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { TaskSummary } from '@/lib/task-api'

import { TaskComposer } from './TaskComposer'
import styles from './TaskDetailPlaceholder.module.css'

interface TaskDetailPlaceholderProps {
  task?: TaskSummary
}

function TranscriptEmptyGraphic(): React.JSX.Element {
  return (
    <div aria-hidden="true" className={cn('flex w-44 flex-col gap-2', styles.emptyGraphic)}>
      <div
        className="flex w-36 items-center gap-3 self-start rounded-xl border bg-card p-3 shadow-minimal"
        data-slot="transcript-empty-step"
        data-step="first"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <MessageSquareText className="size-4" strokeWidth={1.7} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="h-1.5 w-full rounded-full bg-muted" />
          <span className="h-1.5 w-2/3 rounded-full bg-muted" />
        </span>
      </div>
      <div
        className="flex w-36 items-center gap-3 self-end rounded-xl border bg-accent p-3 shadow-minimal"
        data-slot="transcript-empty-step"
        data-step="second"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="h-1.5 w-4/5 rounded-full bg-primary/20" />
          <span className="h-1.5 w-full rounded-full bg-primary/20" />
        </span>
        <Sparkles className="size-4 shrink-0 text-primary" strokeWidth={1.7} />
      </div>
      <span className="self-center" data-slot="transcript-empty-step" data-step="third">
        <MousePointer2 className="size-5 text-muted-foreground" strokeWidth={1.5} />
      </span>
    </div>
  )
}

export function TaskDetailPlaceholder({ task }: TaskDetailPlaceholderProps): React.JSX.Element {
  if (!task) {
    return (
      <section aria-label="Transcript" className="flex h-full min-h-0 p-6">
        <Empty>
          <EmptyMedia>
            <TranscriptEmptyGraphic />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>Select a task</EmptyTitle>
            <EmptyDescription>Choose a task to preview its transcript.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
    )
  }

  return (
    <section
      aria-label={`Transcript for ${task.title}`}
      className="flex h-full min-h-0 flex-col py-8"
    >
      <header className="mx-7 min-w-0 border-b pb-5">
        <h2 className="truncate text-lg font-semibold" title={task.title}>
          {task.title}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">Transcript preview</p>
      </header>
      <div
        className="flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-8 overflow-y-auto px-7 py-8"
        aria-hidden="true"
      >
        <div className="flex flex-col gap-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
        <div className="flex flex-col gap-3 pl-10">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
      <div className="w-full shrink-0 px-4 pb-4">
        <div className="mx-auto w-full max-w-180">
          <TaskComposer key={task.id} />
        </div>
      </div>
    </section>
  )
}
