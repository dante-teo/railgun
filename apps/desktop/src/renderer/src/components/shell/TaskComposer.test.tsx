import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { TaskComposer } from '@/components/shell/TaskComposer'

afterEach(cleanup)

describe('TaskComposer', () => {
  it('exposes selector and send states for motion without owning their behavior', () => {
    const { rerender } = render(
      <TaskComposer approvalExpanded={false} modelExpanded={false} sending={false} />
    )
    const approval = screen.getByRole('button', { name: 'Approval mode: Ask for approval' })
    const model = screen.getByRole('button', { name: 'Select model: GPT-5' })
    const send = screen.getByRole('button', { name: 'Send message' })

    expect(screen.getByRole('group', { name: 'Composer controls' })).toBeInTheDocument()
    expect(approval).toHaveAttribute('aria-expanded', 'false')
    expect(model).toHaveAttribute('aria-expanded', 'false')
    expect(send).toHaveAttribute('data-state', 'idle')

    rerender(<TaskComposer approvalExpanded modelExpanded sending />)

    expect(approval).toHaveAttribute('aria-expanded', 'true')
    expect(model).toHaveAttribute('aria-expanded', 'true')
    expect(send).toHaveAccessibleName('Stop generation')
    expect(send).toHaveAttribute('data-state', 'sending')
  })
})
