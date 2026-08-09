import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { AppShellLayout } from '@/layouts/AppShellLayout'
import {
  readShellLayout,
  SHELL_LAYOUT_CONSTRAINTS,
  SHELL_LAYOUT_STORAGE_KEY,
  type ShellLayoutRecord
} from '@/layouts/app-shell-storage'

const validStoredLayout: ShellLayoutRecord = {
  version: 1,
  sidebarWidth: 312,
  contentWidth: 408,
  inspectorWidth: 384,
  sidebarVisible: true,
  inspectorVisible: true
}

function renderShell({ includeDetail = true }: { includeDetail?: boolean } = {}): ReturnType<
  typeof render
> {
  return render(
    <TooltipProvider>
      <AppShellLayout
        content={<div>Content</div>}
        detail={includeDetail ? <div>Detail</div> : undefined}
        inspector={<div>Inspector body</div>}
        inspectorTopBar={<div>Inspector topbar</div>}
        sidebar={<div>Sidebar body</div>}
        sidebarTopBar={<div>Sidebar topbar</div>}
        workspaceTopBar={<div>Workspace topbar</div>}
      />
    </TooltipProvider>
  )
}

function getShellTopBar(name: 'sidebar' | 'workspace' | 'inspector'): HTMLElement {
  const topBar = document.querySelector<HTMLElement>(`[data-shell-topbar="${name}"]`)
  if (!topBar) {
    throw new Error(`Missing ${name} shell topbar`)
  }

  return topBar
}

describe('AppShellLayout', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(cleanup)

  it('collapses and reopens Sidebar and Inspector with accessible toggle state', () => {
    renderShell()

    const sidebarToggle = screen.getByRole('button', { name: 'Hide sidebar' })
    const inspectorToggle = screen.getByRole('button', { name: 'Hide inspector' })

    expect(sidebarToggle).toHaveAttribute('aria-expanded', 'true')
    expect(inspectorToggle).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(sidebarToggle)
    fireEvent.click(inspectorToggle)

    expect(screen.getByRole('button', { name: 'Show sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.getByRole('button', { name: 'Show inspector' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(document.querySelector('#shell-sidebar-handle')).toBeNull()
    expect(document.querySelector('#shell-inspector-handle')).toBeNull()
    expect(readShellLayout(window.localStorage)).toMatchObject({
      sidebarVisible: false,
      inspectorVisible: false
    })

    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show inspector' }))

    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Hide inspector' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(document.querySelector('#shell-sidebar-handle')).not.toBeNull()
    expect(document.querySelector('#shell-inspector-handle')).not.toBeNull()
    expect(readShellLayout(window.localStorage)).toMatchObject({
      sidebarVisible: true,
      inspectorVisible: true
    })
  })

  it('moves the Sidebar toggle between the Sidebar and Workspace topbars', () => {
    renderShell()

    const sidebarTopBar = getShellTopBar('sidebar')
    const workspaceTopBar = getShellTopBar('workspace')

    expect(within(sidebarTopBar).getByRole('button', { name: 'Hide sidebar' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(sidebarTopBar).toHaveAttribute('data-toggle-layout', 'flow')
    expect(workspaceTopBar).toHaveAttribute('data-toggle-layout', 'flow')
    expect(within(workspaceTopBar).queryByRole('button', { name: 'Hide sidebar' })).toBeNull()

    fireEvent.click(within(sidebarTopBar).getByRole('button', { name: 'Hide sidebar' }))

    expect(within(sidebarTopBar).queryByRole('button', { name: 'Show sidebar' })).toBeNull()
    expect(within(workspaceTopBar).getByRole('button', { name: 'Show sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    fireEvent.click(within(workspaceTopBar).getByRole('button', { name: 'Show sidebar' }))

    expect(within(sidebarTopBar).getByRole('button', { name: 'Hide sidebar' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(within(workspaceTopBar).queryByRole('button', { name: 'Show sidebar' })).toBeNull()
  })

  it('moves the Inspector toggle between the Inspector and Workspace topbars', () => {
    renderShell()

    const inspectorTopBar = getShellTopBar('inspector')
    const workspaceTopBar = getShellTopBar('workspace')

    expect(within(inspectorTopBar).getByRole('button', { name: 'Hide inspector' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(inspectorTopBar).toHaveAttribute('data-toggle-layout', 'flow')
    expect(within(workspaceTopBar).queryByRole('button', { name: 'Hide inspector' })).toBeNull()

    fireEvent.click(within(inspectorTopBar).getByRole('button', { name: 'Hide inspector' }))

    expect(within(inspectorTopBar).queryByRole('button', { name: 'Show inspector' })).toBeNull()
    expect(within(workspaceTopBar).getByRole('button', { name: 'Show inspector' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )

    fireEvent.click(within(workspaceTopBar).getByRole('button', { name: 'Show inspector' }))

    expect(within(inspectorTopBar).getByRole('button', { name: 'Hide inspector' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(within(workspaceTopBar).queryByRole('button', { name: 'Show inspector' })).toBeNull()
  })

  it('restores valid persisted widths after collapse', () => {
    window.localStorage.setItem(SHELL_LAYOUT_STORAGE_KEY, JSON.stringify(validStoredLayout))
    renderShell()

    expect(document.querySelector('#sidebar-panel')).toHaveAttribute('data-default-width', '312')
    expect(document.querySelector('#content-panel')).toHaveAttribute('data-default-width', '408')
    expect(document.querySelector('#inspector-panel')).toHaveAttribute('data-default-width', '384')

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
    expect(document.querySelector('#sidebar-panel')).toHaveAttribute('data-default-width', '312')
  })

  it('enforces the Sidebar minimum and omits Detail cleanly when absent', () => {
    const firstRender = renderShell()

    expect(document.querySelector('#sidebar-panel')).toHaveAttribute(
      'data-min-width',
      String(SHELL_LAYOUT_CONSTRAINTS.sidebar.min)
    )

    firstRender.unmount()
    renderShell({ includeDetail: false })

    expect(document.querySelector('#shell-detail')).toBeNull()
    expect(document.querySelector('#shell-content-detail-handle')).toBeNull()
    expect(document.querySelector('#shell-content')).toHaveAttribute('data-fills-workspace', 'true')
  })

  it('adds traffic-light clearance when Sidebar is collapsed', () => {
    renderShell()
    const workspaceTopBar = document.querySelector('[data-shell-topbar="workspace"]')

    expect(workspaceTopBar).toHaveAttribute('data-traffic-light-clearance', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))
    expect(workspaceTopBar).toHaveAttribute('data-traffic-light-clearance', 'true')
  })

  it('renders exactly three aligned topbars and pane-body starts', () => {
    renderShell()

    expect(document.querySelectorAll('[data-shell-topbar]')).toHaveLength(3)
    const resizeHandles = Array.from(document.querySelectorAll('[data-slot="resizable-handle"]'))
    expect(resizeHandles).toHaveLength(3)
    expect(
      resizeHandles.every(
        (handle) =>
          handle.children.length === 1 &&
          handle.firstElementChild?.getAttribute('data-slot') === 'resizable-handle-indicator'
      )
    ).toBe(true)
    expect(document.querySelector('[data-shell-topbar="workspace"]')).toHaveAttribute(
      'data-shares-content-detail',
      'true'
    )
    expect(document.querySelector('[data-shell-topbar="sidebar"]')).toHaveAttribute(
      'data-integrated-with-body',
      'true'
    )
    expect(document.querySelector('[data-shell-topbar="inspector"]')).toHaveAttribute(
      'data-integrated-with-body',
      'true'
    )
    expect(document.querySelector('#shell-content [data-shell-topbar]')).toBeNull()
    expect(document.querySelector('#shell-detail [data-shell-topbar]')).toBeNull()
    const paneBodies = Array.from(document.querySelectorAll('[data-pane-body]'))
    expect(paneBodies).toHaveLength(4)
    expect(paneBodies.every((body) => body.getAttribute('data-pane-body-start') === '52')).toBe(
      true
    )
  })
})
