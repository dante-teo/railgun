import { fireEvent, render, screen } from '@testing-library/react'
import { PanelLeft } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'

import { PaneToggle } from '@/components/shell/PaneToggle'
import { TooltipProvider } from '@/components/ui/tooltip'

describe('PaneToggle', () => {
  it('exposes pane state and delegates activation', () => {
    const onToggle = vi.fn()

    render(
      <TooltipProvider>
        <PaneToggle
          controls="shell-sidebar"
          expanded={false}
          icon={PanelLeft}
          label="Show sidebar"
          onToggle={onToggle}
        />
      </TooltipProvider>
    )

    const toggle = screen.getByRole('button', { name: 'Show sidebar' })
    expect(toggle).toHaveAttribute('aria-controls', 'shell-sidebar')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('data-size', 'icon-sm')
    expect(toggle).toHaveAttribute('data-variant', 'topbar')

    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledOnce()
  })
})
