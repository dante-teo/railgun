import { Ellipsis, LoaderCircle, SquarePen } from 'lucide-react'

import { TopBarIconButton } from '@/components/shell/TopBarIconButton'
import { cn } from '@/lib/utils'

import styles from './ShellTopBars.module.css'

export function SidebarTopBar(): React.JSX.Element {
  return <span className="sr-only">Railgun navigation</span>
}

export function ScheduledWorkspaceTopBar(): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 items-center px-4 in-data-[traffic-light-clearance=true]:pl-2">
      <h2 className="truncate text-[17px] font-semibold leading-none tracking-[-0.01em]">
        Scheduled
      </h2>
    </div>
  )
}

interface TasksWorkspaceTopBarProps {
  createDisabled?: boolean
  creating?: boolean
  onCreateTask?: () => void
}

export function TasksWorkspaceTopBar({
  createDisabled = false,
  creating = false,
  onCreateTask
}: TasksWorkspaceTopBarProps = {}): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 items-center px-4 in-data-[traffic-light-clearance=true]:pl-2">
      <TopBarIconButton
        aria-busy={creating || undefined}
        aria-label="Create task"
        className={styles.createTaskButton}
        data-creating={creating || undefined}
        disabled={createDisabled || creating}
        onClick={onCreateTask}
      >
        <span aria-hidden="true" className="relative size-4">
          <span
            className={cn(
              'absolute inset-0 flex size-4 items-center justify-center',
              styles.createTaskGlyph,
              styles.createTaskIdleGlyph
            )}
            data-slot="create-task-idle-glyph"
          >
            <SquarePen className="size-4" strokeWidth={1.7} />
          </span>
          <span
            className={cn(
              'absolute inset-0 flex size-4 items-center justify-center',
              styles.createTaskGlyph,
              styles.createTaskBusyGlyph
            )}
            data-slot="create-task-busy-glyph"
          >
            <span className={cn('flex size-4 animate-spin', styles.createTaskSpinner)}>
              <LoaderCircle className="size-4" strokeWidth={1.7} />
            </span>
          </span>
        </span>
      </TopBarIconButton>
    </div>
  )
}

export function InspectorTopBar(): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 items-center pl-4">
      <h2 className="truncate text-[17px] font-semibold leading-none tracking-[-0.01em]">
        Inspector
      </h2>
      <TopBarIconButton aria-label="Inspector actions" className="ml-auto">
        <Ellipsis aria-hidden="true" data-icon="inline-start" strokeWidth={2} />
      </TopBarIconButton>
    </div>
  )
}
