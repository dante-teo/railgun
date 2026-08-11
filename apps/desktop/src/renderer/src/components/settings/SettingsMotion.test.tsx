import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsAnimatedList, SettingsCrossfade, SettingsListItem } from './SettingsMotion'

function mockSettingsListPositions(positions: ReadonlyMap<string, number>): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const top = positions.get(this.dataset.settingsListKey ?? '') ?? 0
    return {
      bottom: top + 40,
      height: 40,
      left: 0,
      right: 100,
      top,
      width: 100,
      x: 0,
      y: top,
      toJSON: () => undefined
    }
  })
}

describe('Settings motion', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (HTMLElement.prototype as { animate?: unknown }).animate
  })

  it('crossfades keyed states while making the outgoing state immediately inert', () => {
    const { rerender } = render(
      <SettingsCrossfade stateKey="loading">
        <button type="button">Loading action</button>
      </SettingsCrossfade>
    )

    rerender(
      <SettingsCrossfade stateKey="ready">
        <button type="button">Ready action</button>
      </SettingsCrossfade>
    )

    const outgoing = screen.getByRole('button', {
      name: 'Loading action',
      hidden: true
    }).parentElement!
    expect(outgoing).toHaveAttribute('aria-hidden', 'true')
    expect(outgoing).toHaveAttribute('inert')
    expect(outgoing).toHaveAttribute('data-motion', 'exiting')
    expect(screen.getByRole('button', { name: 'Ready action' })).toBeEnabled()

    fireEvent.transitionEnd(outgoing, { propertyName: 'opacity' })
    expect(screen.queryByText('Loading action')).not.toBeInTheDocument()
  })

  it('keeps an exiting row mounted until its opacity transition completes', () => {
    const onExitComplete = vi.fn()
    const { rerender } = render(
      <ul>
        <SettingsListItem itemKey="one" onExitComplete={onExitComplete}>
          First row
        </SettingsListItem>
      </ul>
    )

    rerender(
      <ul>
        <SettingsListItem exiting itemKey="one" onExitComplete={onExitComplete}>
          First row
        </SettingsListItem>
      </ul>
    )

    const row = screen.getByText('First row').closest('li')!
    expect(row).toHaveAttribute('data-motion', 'exiting')
    expect(row).toHaveAttribute('aria-hidden', 'true')
    expect(row).toHaveAttribute('inert')

    fireEvent.transitionEnd(row, { propertyName: 'transform' })
    expect(onExitComplete).not.toHaveBeenCalled()
    fireEvent.transitionEnd(row, { propertyName: 'opacity' })
    expect(onExitComplete).toHaveBeenCalledOnce()
  })

  it('uses FLIP transforms to preserve the position of surviving rows', () => {
    const animate = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate
    })
    const positions = new Map([
      ['one', 0],
      ['two', 48]
    ])
    mockSettingsListPositions(positions)

    function ListFixture(): React.JSX.Element {
      const [items, setItems] = useState(['one', 'two'])
      const [motionRevision, setMotionRevision] = useState(0)
      return (
        <>
          <button
            onClick={() => {
              positions.set('two', 0)
              setItems(['two'])
              setMotionRevision((current) => current + 1)
            }}
            type="button"
          >
            Remove first
          </button>
          <SettingsAnimatedList ariaLabel="Rows" motionRevision={motionRevision}>
            {items.map((item) => (
              <SettingsListItem itemKey={item} key={item}>
                {item}
              </SettingsListItem>
            ))}
          </SettingsAnimatedList>
        </>
      )
    }

    render(<ListFixture />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove first' }))

    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translateY(48px)' }, { transform: 'translateY(0)' }],
      { duration: 120, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
    )
  })

  it('skips animation timing work when a mutation revision does not move a row', () => {
    const animate = vi.fn()
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle')
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate
    })
    mockSettingsListPositions(new Map([['one', 0]]))

    const { rerender } = render(
      <SettingsAnimatedList ariaLabel="Rows" motionRevision={0}>
        <SettingsListItem itemKey="one">before</SettingsListItem>
      </SettingsAnimatedList>
    )
    rerender(
      <SettingsAnimatedList ariaLabel="Rows" motionRevision={1}>
        <SettingsListItem itemKey="one">after</SettingsListItem>
      </SettingsAnimatedList>
    )

    expect(animate).not.toHaveBeenCalled()
    expect(getComputedStyle).not.toHaveBeenCalled()
  })

  it('keeps keyboard-driven list filtering immediate without a mutation revision', () => {
    const animate = vi.fn()
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle')
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate
    })
    const positions = new Map([
      ['one', 0],
      ['two', 48]
    ])
    mockSettingsListPositions(positions)

    const { rerender } = render(
      <SettingsAnimatedList ariaLabel="Rows" motionRevision={0}>
        <SettingsListItem itemKey="one">one</SettingsListItem>
        <SettingsListItem itemKey="two">two</SettingsListItem>
      </SettingsAnimatedList>
    )
    positions.set('two', 0)
    rerender(
      <SettingsAnimatedList ariaLabel="Rows" motionRevision={0}>
        <SettingsListItem itemKey="two">two</SettingsListItem>
      </SettingsAnimatedList>
    )

    expect(animate).not.toHaveBeenCalled()
    expect(getComputedStyle).not.toHaveBeenCalled()
  })
})
