import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskList } from '@/components/shell/TaskList'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { TaskSummary } from '@/lib/task-api'

const task: TaskSummary = {
  id: 'task-1',
  title:
    'A deliberately long task title that must remain on one line without moving the archive action',
  lastMessageAt: '2026-08-08T03:04:05.000Z'
}

function renderTaskList(
  props: Partial<React.ComponentProps<typeof TaskList>> = {}
): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <TaskList
        archiveDisabled={false}
        loading={false}
        onArchive={() => undefined}
        onArchiveExit={() => undefined}
        onSelect={() => undefined}
        tasks={[task]}
        {...props}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 7, 9, 12))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TaskList', () => {
  it('renders shadcn skeletons while loading', () => {
    renderTaskList({ loading: true, tasks: [] })

    expect(screen.getByRole('status', { name: 'Task list is loading' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Task list' })).toHaveAttribute('aria-busy', 'true')
  })

  it('renders dedicated empty and error states', () => {
    const view = renderTaskList({ tasks: [] })
    expect(screen.getByText('No tasks yet')).toBeInTheDocument()

    view.rerender(
      <TooltipProvider>
        <TaskList
          archiveDisabled={false}
          loadError="Could not load tasks."
          loading={false}
          onArchive={() => undefined}
          onArchiveExit={() => undefined}
          onSelect={() => undefined}
          tasks={[]}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('Tasks unavailable')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tasks.')
  })

  it('truncates long titles and exposes an accessible archive action and full timestamp', () => {
    const onArchive = vi.fn()
    renderTaskList({ onArchive })

    const title = screen.getByText(task.title)
    expect(title).toHaveClass('truncate')
    expect(title).toHaveAttribute('title', task.title)

    const time = screen.getByText('Yesterday')
    expect(time.tagName).toBe('TIME')
    expect(time).toHaveAttribute('datetime', task.lastMessageAt)
    expect(time).toHaveAttribute('title')

    const archive = screen.getByRole('button', { name: `Archive ${task.title}` })
    expect(archive).toHaveClass('opacity-0', 'transition-opacity')
    expect(archive).toHaveAttribute('data-variant', 'rowAction')
    expect(archive).toHaveClass(
      'text-muted-foreground',
      'hover:bg-transparent',
      'hover:text-foreground'
    )
    fireEvent.click(archive)
    expect(onArchive).toHaveBeenCalledWith(task.id)
  })

  it('shows task action errors alongside populated rows', () => {
    renderTaskList({ taskActionError: 'Could not archive the task.' })

    expect(screen.getByRole('alert')).toHaveTextContent('Could not archive the task.')
    expect(screen.getByText(task.title)).toBeInTheDocument()
  })

  it('reports selection through a pressed task action', () => {
    const onSelect = vi.fn()
    renderTaskList({ onSelect, selectedTaskId: task.id })

    const select = screen.getByRole('button', { name: `Select ${task.title}` })
    expect(select).toHaveAttribute('aria-pressed', 'true')
    expect(select.closest('li')).toHaveClass('bg-muted', 'hover:bg-muted', 'focus-within:bg-muted')
    fireEvent.click(select)
    expect(onSelect).toHaveBeenCalledWith(task.id)
  })

  it('reports an archived row only after its opacity transition completes', () => {
    const onArchiveExit = vi.fn()
    renderTaskList({ archivingTaskId: task.id, onArchiveExit })

    const row = screen.getByText(task.title).closest('li')
    expect(row).toHaveAttribute('aria-hidden', 'true')
    expect(row).toHaveAttribute('data-archiving', 'true')
    expect(row).toHaveClass('data-[archiving=true]:translate-x-1')

    fireEvent.transitionEnd(row!, { propertyName: 'transform' })
    expect(onArchiveExit).not.toHaveBeenCalled()
    fireEvent.transitionEnd(row!, { propertyName: 'opacity' })
    expect(onArchiveExit).toHaveBeenCalledWith(task.id)
  })

  it('crossfades the loading surface into loaded content', () => {
    const view = renderTaskList({ loading: true, tasks: [] })
    const loadingStatus = screen.getByRole('status', { name: 'Task list is loading' })
    const loadingSurface = loadingStatus.closest('[data-slot="task-list-state"]')

    view.rerender(
      <TooltipProvider>
        <TaskList
          archiveDisabled={false}
          loading={false}
          onArchive={() => undefined}
          onArchiveExit={() => undefined}
          onSelect={() => undefined}
          tasks={[]}
        />
      </TooltipProvider>
    )

    expect(loadingSurface).toHaveAttribute('aria-hidden', 'true')
    expect(loadingSurface).toHaveAttribute('data-visible', 'false')
    expect(screen.getByText('No tasks yet').closest('[data-slot="task-list-state"]')).toHaveClass(
      'animate-in',
      'fade-in-0'
    )

    fireEvent.transitionEnd(loadingSurface!, { propertyName: 'opacity' })
    expect(loadingSurface).not.toBeInTheDocument()
  })
})
