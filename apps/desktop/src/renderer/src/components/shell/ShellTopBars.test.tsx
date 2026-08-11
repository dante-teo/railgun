import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

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
})
