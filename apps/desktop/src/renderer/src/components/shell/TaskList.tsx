import { Bug, Circle, FileCheck2, FileText, SquareCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

interface TaskListRowProps {
  icon: LucideIcon
  title: string
  date: string
  selected?: boolean
}

const TASKS: readonly TaskListRowProps[] = [
  { icon: FileText, title: 'Draft project brief', date: 'Today', selected: true },
  { icon: Circle, title: 'Review design concepts', date: 'Tomorrow' },
  { icon: SquareCheck, title: 'Stakeholder sync', date: 'May 28' },
  { icon: FileCheck2, title: 'Implement auth flow', date: 'May 29' },
  { icon: Bug, title: 'Fix sidebar spacing', date: 'May 30' },
  { icon: FileText, title: 'Write release notes', date: 'Jun 2' }
]

function TaskListRow({
  icon: Icon,
  title,
  date,
  selected = false
}: TaskListRowProps): React.JSX.Element {
  return (
    <article
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex min-h-[73px] items-center gap-3 border-b border-l-2 border-l-transparent px-4 py-3',
        selected && 'border-l-primary bg-card'
      )}
    >
      <Icon
        aria-hidden="true"
        className="size-[19px] shrink-0 text-muted-foreground"
        strokeWidth={1.55}
      />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[14px] font-medium leading-5">{title}</h2>
        <p className="truncate text-[12px] leading-5 text-muted-foreground">{date}</p>
      </div>
      <Circle
        aria-hidden="true"
        className="size-[17px] shrink-0 text-subtle-foreground"
        strokeWidth={1.5}
      />
    </article>
  )
}

export function TaskList(): React.JSX.Element {
  return (
    <section aria-label="Task list" className="h-full overflow-y-auto px-3 pt-4">
      {TASKS.map((task) => (
        <TaskListRow key={task.title} {...task} />
      ))}
    </section>
  )
}
