import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TaskInteractionRows } from '@/components/shell/TaskInteractions'
import type { TranscriptApprovalRequest } from '@/lib/transcript-api'

const pendingRequest: TranscriptApprovalRequest = {
  id: 'approval-one',
  type: 'approval',
  command: 'pnpm test',
  status: 'pending',
  error: null
}

function renderRows(
  request: TranscriptApprovalRequest = pendingRequest
): ReturnType<typeof render> {
  return render(
    <ol>
      <TaskInteractionRows requests={[request]} sessionId="session-one" />
    </ol>
  )
}

describe('TaskInteractionRows', () => {
  it('keeps a resolved request inert until its exit transition finishes', () => {
    const view = renderRows()
    const row = screen.getByRole('group', { name: 'Approval request' }).closest('li')

    view.rerender(
      <ol>
        <TaskInteractionRows requests={[]} sessionId="session-one" />
      </ol>
    )

    expect(row).toHaveAttribute('aria-hidden', 'true')
    expect(row).toHaveAttribute('data-present', 'false')
    expect(row).toHaveAttribute('inert')

    fireEvent.transitionEnd(row!, { propertyName: 'transform' })
    expect(row).toBeInTheDocument()
    fireEvent.transitionEnd(row!, { propertyName: 'opacity' })
    expect(row).not.toBeInTheDocument()
  })

  it('drops retained requests immediately when the session changes', () => {
    const view = renderRows()
    const row = screen.getByRole('group', { name: 'Approval request' }).closest('li')

    view.rerender(
      <ol>
        <TaskInteractionRows requests={[]} sessionId="session-two" />
      </ol>
    )

    expect(row).not.toBeInTheDocument()
  })

  it('crossfades status changes while exposing only the current status', () => {
    const view = renderRows()
    const statusSlot = document.querySelector('[data-slot="interaction-status"]')
    expect(statusSlot).toHaveClass('grid', 'min-h-5')

    view.rerender(
      <ol>
        <TaskInteractionRows
          requests={[{ ...pendingRequest, status: 'responding' }]}
          sessionId="session-one"
        />
      </ol>
    )

    const responding = screen.getByRole('status')
    expect(responding).toHaveTextContent('Submitting response…')

    view.rerender(
      <ol>
        <TaskInteractionRows
          requests={[{ ...pendingRequest, error: 'Request failed.' }]}
          sessionId="session-one"
        />
      </ol>
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Request failed.')
    expect(responding).toHaveAttribute('aria-hidden', 'true')
    expect(responding).not.toHaveAttribute('role')

    fireEvent.transitionEnd(responding, { propertyName: 'opacity' })
    expect(responding).not.toBeInTheDocument()
  })
})
