import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ContextRing } from '@/components/shell/ContextRing'
import { contextUsagePresentation } from '@/lib/context-usage-presentation'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ContextRing', () => {
  it('keeps unreported usage distinct from zero usage', () => {
    expect(contextUsagePresentation({ contextWindow: 200_000, usedTokens: null })).toEqual({
      accessibilityText: 'Context usage not measured yet',
      detailText: 'Not measured yet',
      percentage: null,
      visualPercentage: 0
    })

    render(<ContextRing contextWindow={200_000} usedTokens={null} />)
    expect(
      screen.getByRole('meter', { name: 'Context usage not measured yet' })
    ).toBeInTheDocument()
  })

  it('presents provider-reported input plus output tokens and caps only the visual ring', () => {
    expect(contextUsagePresentation({ contextWindow: 200_000, usedTokens: 150_000 })).toEqual({
      accessibilityText:
        'Latest provider-reported input plus output tokens: 150,000 of 200,000 tokens, 75 percent',
      detailText: '150,000 of 200,000',
      percentage: 75,
      visualPercentage: 75
    })
    expect(contextUsagePresentation({ contextWindow: 100, usedTokens: 125 })).toMatchObject({
      percentage: 125,
      visualPercentage: 100
    })

    render(<ContextRing contextWindow={200_000} usedTokens={150_000} />)
    const indicator = screen.getByTestId('context-ring-indicator')
    expect(indicator).toHaveAttribute('stroke-dashoffset', '25')
  })

  it('opens native-style context details from the keyboard trigger', () => {
    render(<ContextRing contextWindow={200_000} usedTokens={150_000} />)

    fireEvent.focus(
      screen.getByRole('meter', {
        name: /Latest provider-reported input plus output tokens/
      })
    )

    expect(screen.getByRole('heading', { name: 'Context' })).toBeInTheDocument()
    expect(screen.getByText('75% used')).toBeInTheDocument()
    expect(screen.getByText('150,000 of 200,000')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Context window usage' })).toHaveAttribute(
      'aria-valuenow',
      '75'
    )
  })

  it('waits before opening on hover and cancels when the pointer leaves early', () => {
    vi.useFakeTimers()
    render(<ContextRing contextWindow={200_000} usedTokens={150_000} />)
    const trigger = screen.getByRole('meter', {
      name: /Latest provider-reported input plus output tokens/
    })

    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(449))
    expect(screen.queryByRole('heading', { name: 'Context' })).not.toBeInTheDocument()
    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('heading', { name: 'Context' })).not.toBeInTheDocument()

    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(450))
    expect(screen.getByRole('heading', { name: 'Context' })).toBeInTheDocument()
  })

  it('is informational rather than clickable', () => {
    render(<ContextRing contextWindow={200_000} usedTokens={150_000} />)
    const trigger = screen.getByRole('meter', {
      name: /Latest provider-reported input plus output tokens/
    })

    fireEvent.click(trigger)

    expect(screen.queryByRole('heading', { name: 'Context' })).not.toBeInTheDocument()
  })
})
