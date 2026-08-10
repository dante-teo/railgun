import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PersonalAgentActivityCard } from '@/components/shell/PersonalAgentActivityCard'
import { SidebarNavigation } from '@/components/shell/SidebarNavigation'
import {
  emptyActivitySnapshot,
  type ActivitySnapshot,
  type SubagentActivity,
  type TodoActivity
} from '@/lib/activity-api'

function subagent(
  index: number,
  goal: string,
  response: string,
  status: SubagentActivity['status'] = 'running'
): SubagentActivity {
  return {
    index,
    goal,
    status,
    messages: [
      { role: 'user', content: goal },
      { role: 'assistant', content: response }
    ]
  }
}

function snapshot(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return { ...emptyActivitySnapshot(), ...overrides }
}

const progressTodos: TodoActivity[] = [
  { id: '1', content: 'Completed one', status: 'completed' },
  { id: '2', content: 'Completed two', status: 'completed' },
  { id: '3', content: 'Completed three', status: 'completed' },
  { id: '4', content: 'Completed four', status: 'completed' },
  { id: '5', content: 'Pending five', status: 'pending' },
  { id: '6', content: 'Active six', status: 'in_progress' },
  { id: '7', content: 'Cancelled seven', status: 'cancelled' },
  { id: '8', content: 'Cancelled eight', status: 'cancelled' }
]

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('PersonalAgentActivityCard', () => {
  it('renders Advisor, Subagents, rows, then active Tasks without the old Sidecar anatomy', () => {
    const activity = snapshot({
      advisor: { severity: 'nit', text: 'Latest advice' },
      subagentCount: 2,
      subagents: [
        subagent(0, 'Inspect activity', 'Inspected', 'completed'),
        subagent(1, 'Verify interaction', '', 'running')
      ],
      todos: progressTodos
    })
    const { container } = render(<SidebarNavigation activity={activity} />)
    const region = screen.getByRole('region', { name: 'Personal agent activity' })
    const advisor = within(region).getByRole('button', { name: 'Advisor' })
    const firstSubagent = within(region).getByRole('button', { name: /Inspect activity/ })
    const secondSubagent = within(region).getByRole('button', { name: /Verify interaction/ })
    const tasks = within(region).getByRole('button', { name: /Tasks 4\/8/ })

    expect(
      advisor.compareDocumentPosition(firstSubagent) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      firstSubagent.compareDocumentPosition(secondSubagent) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      secondSubagent.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(within(region).getByText('Subagents').nextElementSibling).toHaveTextContent('2')
    expect(screen.queryByText('Sidecar')).not.toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sidecar actions' })).not.toBeInTheDocument()
    expect(region.parentElement).not.toHaveClass('border-t')
    expect(container.querySelector('hr')).toBeNull()
  })

  it('reveals Advisor on pointer hover or focus, pins it on click, and dismisses with Escape', async () => {
    vi.useFakeTimers()
    render(
      <PersonalAgentActivityCard
        snapshot={snapshot({ advisor: { severity: 'concern', text: 'Check keyboard access.' } })}
      />
    )
    const trigger = screen.getByRole('button', { name: 'Advisor' })

    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    expect(screen.getByRole('dialog', { name: 'Advisor preview' })).toHaveTextContent(
      'Check keyboard access.'
    )
    fireEvent.click(trigger)
    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(100))
    expect(screen.getByRole('dialog', { name: 'Advisor preview' })).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Advisor preview' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Advisor preview' })).not.toBeInTheDocument()

    fireEvent.focus(trigger)
    expect(screen.getByRole('dialog', { name: 'Advisor preview' })).toBeInTheDocument()
    fireEvent.blur(trigger)
    act(() => vi.advanceTimersByTime(100))
    expect(screen.queryByRole('dialog', { name: 'Advisor preview' })).not.toBeInTheDocument()
  })

  it('shows the Advisor empty state and updates an open subagent streaming response', () => {
    const activity = snapshot({
      subagentCount: 1,
      subagents: [subagent(0, 'Inspect streaming', 'Partial')]
    })
    const view = render(<PersonalAgentActivityCard snapshot={activity} />)

    fireEvent.focus(screen.getByRole('button', { name: 'Advisor' }))
    expect(screen.getByRole('dialog', { name: 'Advisor preview' })).toHaveTextContent(
      'No advisor message yet.'
    )
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Advisor preview' }), { key: 'Escape' })

    const subagentTrigger = screen.getByRole('button', { name: /Inspect streaming/ })
    fireEvent.focus(subagentTrigger)
    expect(
      screen.getByRole('dialog', { name: /Subagent: Inspect streaming preview/ })
    ).toHaveTextContent('Partial')
    view.rerender(
      <PersonalAgentActivityCard
        snapshot={snapshot({
          revision: 1,
          subagentCount: 1,
          subagents: [subagent(0, 'Inspect streaming', 'Partial response')]
        })}
      />
    )
    expect(
      screen.getByRole('dialog', { name: /Subagent: Inspect streaming preview/ })
    ).toHaveTextContent('Partial response')
  })

  it('shows 4/8 and every TODO status while work is active, then hides Tasks when none is active', () => {
    const view = render(<PersonalAgentActivityCard snapshot={snapshot({ todos: progressTodos })} />)
    const tasks = screen.getByRole('button', { name: /Tasks 4\/8/ })
    fireEvent.focus(tasks)
    const preview = screen.getByRole('dialog', { name: 'Tasks preview' })

    for (const todo of progressTodos) {
      expect(within(preview).getByText(todo.content)).toBeInTheDocument()
    }
    expect(preview).toHaveTextContent('In progress')
    expect(preview).toHaveTextContent('Cancelled')

    view.rerender(
      <PersonalAgentActivityCard
        snapshot={snapshot({
          revision: 1,
          todos: progressTodos.map((todo) => ({
            ...todo,
            status:
              todo.status === 'pending' || todo.status === 'in_progress' ? 'completed' : todo.status
          }))
        })}
      />
    )
    expect(screen.queryByRole('button', { name: /Tasks/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Tasks preview' })).not.toBeInTheDocument()
  })

  it('retains activity rows for exit and removes them after their opacity transition', () => {
    const activity = snapshot({
      subagentCount: 1,
      subagents: [subagent(0, 'Inspect lifecycle', '', 'running')],
      todos: progressTodos
    })
    const view = render(<PersonalAgentActivityCard snapshot={activity} />)
    const subagentPresence = view.container.querySelector<HTMLElement>(
      '[data-activity-row="subagent"]'
    )
    const tasksPresence = view.container.querySelector<HTMLElement>('[data-activity-row="tasks"]')

    view.rerender(
      <PersonalAgentActivityCard
        snapshot={snapshot({
          revision: 1,
          todos: progressTodos.map((todo) => ({ ...todo, status: 'completed' }))
        })}
      />
    )

    expect(subagentPresence).toHaveAttribute('data-present', 'false')
    expect(subagentPresence).toHaveAttribute('aria-hidden', 'true')
    expect(tasksPresence).toHaveAttribute('data-present', 'false')
    expect(screen.queryByRole('button', { name: /Inspect lifecycle/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Tasks/ })).not.toBeInTheDocument()

    fireEvent.transitionEnd(subagentPresence!, { propertyName: 'opacity' })
    fireEvent.transitionEnd(tasksPresence!, { propertyName: 'opacity' })
    expect(view.container.querySelector('[data-activity-row="subagent"]')).toBeNull()
    expect(view.container.querySelector('[data-activity-row="tasks"]')).toBeNull()
  })

  it('cancels an interrupted row exit and crossfades terminal status text', () => {
    const running = subagent(0, 'Verify interruption', '', 'running')
    const view = render(
      <PersonalAgentActivityCard snapshot={snapshot({ subagentCount: 1, subagents: [running] })} />
    )

    view.rerender(<PersonalAgentActivityCard snapshot={snapshot({ revision: 1 })} />)
    const presence = view.container.querySelector<HTMLElement>('[data-activity-row="subagent"]')
    expect(presence).toHaveAttribute('data-present', 'false')

    view.rerender(
      <PersonalAgentActivityCard
        snapshot={snapshot({
          revision: 2,
          subagentCount: 1,
          subagents: [subagent(0, 'Verify interruption', 'Verified', 'completed')]
        })}
      />
    )
    expect(presence).toHaveAttribute('data-present', 'true')
    fireEvent.transitionEnd(presence!, { propertyName: 'opacity' })
    expect(view.container.querySelector('[data-activity-row="subagent"]')).toBe(presence)

    const status = view.container.querySelector('[data-slot="activity-status"]')
    const runningLayer = within(status as HTMLElement).getByText('Running')
    const completedLayer = within(status as HTMLElement).getByText('Completed')
    expect(runningLayer).toHaveAttribute('data-present', 'false')
    expect(completedLayer).toHaveAttribute('data-present', 'true')
    expect(completedLayer).toHaveAttribute('data-entering', 'true')

    fireEvent.transitionEnd(runningLayer, { propertyName: 'opacity' })
    expect(within(status as HTMLElement).queryByText('Running')).not.toBeInTheDocument()
    expect(within(status as HTMLElement).getByText('Completed')).toBeInTheDocument()
  })

  it('cleans up an exiting row when the browser omits transitionend', () => {
    vi.useFakeTimers()
    const view = render(<PersonalAgentActivityCard snapshot={snapshot({ todos: progressTodos })} />)
    view.rerender(
      <PersonalAgentActivityCard
        snapshot={snapshot({
          revision: 1,
          todos: progressTodos.map((todo) => ({ ...todo, status: 'completed' }))
        })}
      />
    )

    expect(view.container.querySelector('[data-activity-row="tasks"]')).not.toBeNull()
    act(() => vi.runAllTimers())
    expect(view.container.querySelector('[data-activity-row="tasks"]')).toBeNull()
  })
})
