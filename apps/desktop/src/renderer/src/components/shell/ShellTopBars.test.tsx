import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InspectorTopBar, TasksWorkspaceTopBar } from '@/components/shell/ShellTopBars'

describe('ShellTopBars', () => {
  afterEach(cleanup)

  it('uses the shared compact treatment for every topbar icon button', () => {
    render(
      <>
        <TasksWorkspaceTopBar />
        <InspectorTopBar />
      </>
    )

    const createTaskButton = screen.getByRole('button', { name: 'Create task' })
    const iconButtons = [
      createTaskButton,
      screen.getByRole('button', { name: 'Inspector actions' })
    ]

    for (const button of iconButtons) {
      expect(button).toHaveAttribute('data-size', 'icon-sm')
      expect(button).toHaveAttribute('data-variant', 'topbar')
    }
  })

  it('keeps the Workspace topbar text-free with Create Task first in flow', () => {
    const { container } = render(<TasksWorkspaceTopBar />)
    const createTaskButton = screen.getByRole('button', { name: 'Create task' })
    const workspaceTopBar = container.firstElementChild

    expect(workspaceTopBar).toHaveClass('px-4', 'in-data-[traffic-light-clearance=true]:pl-2')
    expect(screen.queryByText('Tasks')).toBeNull()
    expect(screen.queryByText('Draft project brief')).toBeNull()
    expect(workspaceTopBar).toHaveTextContent('')
    expect(workspaceTopBar?.children).toHaveLength(1)
    expect(workspaceTopBar?.firstElementChild).toBe(createTaskButton)
  })

  it('forwards create-task activation and exposes its creating state', () => {
    const onCreateTask = vi.fn()
    const { rerender } = render(<TasksWorkspaceTopBar onCreateTask={onCreateTask} />)
    const createTaskButton = screen.getByRole('button', { name: 'Create task' })

    createTaskButton.click()
    expect(onCreateTask).toHaveBeenCalledOnce()

    rerender(<TasksWorkspaceTopBar creating onCreateTask={onCreateTask} />)
    expect(createTaskButton).toBeDisabled()
    expect(createTaskButton).toHaveAttribute('aria-busy', 'true')
    expect(createTaskButton).toHaveAttribute('data-creating', 'true')
    expect(createTaskButton.querySelector('[data-slot="create-task-idle-glyph"]')).not.toBeNull()
    expect(createTaskButton.querySelector('[data-slot="create-task-busy-glyph"]')).not.toBeNull()

    rerender(<TasksWorkspaceTopBar createDisabled onCreateTask={onCreateTask} />)
    expect(createTaskButton).toBeDisabled()
    expect(createTaskButton).not.toHaveAttribute('aria-busy')
    expect(createTaskButton).not.toHaveAttribute('data-creating')
    createTaskButton.click()
    expect(onCreateTask).toHaveBeenCalledOnce()
  })
})
