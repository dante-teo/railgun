import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { FeedbackPresence } from './FeedbackPresence'

afterEach(cleanup)

describe('FeedbackPresence', () => {
  it('retains exiting feedback until its opacity transition completes', () => {
    const { rerender } = render(
      <FeedbackPresence data-slot="feedback" role="alert">
        Could not save
      </FeedbackPresence>
    )
    const feedback = screen.getByRole('alert')
    expect(feedback).toHaveClass('transition-[opacity,translate]')
    expect(feedback).toHaveClass('motion-reduce:translate-none!')

    rerender(
      <FeedbackPresence data-slot="feedback" role="alert">
        {null}
      </FeedbackPresence>
    )

    expect(feedback).toHaveTextContent('Could not save')
    expect(feedback).toHaveAttribute('aria-hidden', 'true')
    expect(feedback).toHaveAttribute('data-present', 'false')
    expect(feedback).toHaveAttribute('inert')

    fireEvent.transitionEnd(feedback, { propertyName: 'translate' })
    expect(feedback).toBeInTheDocument()

    fireEvent.transitionEnd(feedback, { propertyName: 'opacity' })
    expect(feedback).not.toBeInTheDocument()
  })

  it('retargets an interrupted exit from the current transition state', () => {
    const { rerender } = render(
      <FeedbackPresence present role="alert" stateKey="first-error">
        First error
      </FeedbackPresence>
    )

    rerender(
      <FeedbackPresence present={false} role="alert" stateKey="hidden">
        {null}
      </FeedbackPresence>
    )
    rerender(
      <FeedbackPresence present role="alert" stateKey="updated-error">
        Updated error
      </FeedbackPresence>
    )

    const feedback = screen.getByRole('alert')
    expect(feedback).toHaveTextContent('Updated error')
    expect(feedback).toHaveAttribute('data-present', 'true')

    fireEvent.transitionEnd(feedback, { propertyName: 'opacity' })
    expect(feedback).toBeInTheDocument()
  })
})
