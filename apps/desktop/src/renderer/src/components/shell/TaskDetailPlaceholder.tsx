import { MessageSquareText, MousePointer2, Sparkles } from 'lucide-react'

import { useTranscript } from '@/hooks/use-transcript'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { cn } from '@/lib/utils'
import type { TaskSummary } from '@/lib/task-api'

import { TaskTranscript } from './TaskTranscript'
import styles from './TaskDetailPlaceholder.module.css'

interface TaskDetailPlaceholderProps {
  onSessionChanged?: (previousSessionId: string, sessionId: string) => void
  onTaskSaved?: () => void
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

export function TaskDetailPlaceholder({
  onSessionChanged,
  onTaskSaved,
  task
}: TaskDetailPlaceholderProps): React.JSX.Element {
  const transcript = useTranscript()
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
    <TaskTranscript
      key={task.id}
      onSessionChanged={onSessionChanged}
      onTaskSaved={onTaskSaved}
      snapshot={transcript}
      task={task}
    />
  )
}
