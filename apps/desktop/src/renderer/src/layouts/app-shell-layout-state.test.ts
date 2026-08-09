import { describe, expect, it } from 'vitest'

import { commitOuterPanelLayout } from '@/layouts/app-shell-layout-state'
import type { ShellLayoutRecord } from '@/layouts/app-shell-storage'

const currentLayout: ShellLayoutRecord = {
  version: 1,
  sidebarWidth: 312,
  contentWidth: 408,
  inspectorWidth: 384,
  sidebarVisible: true,
  inspectorVisible: true
}

describe('outer panel layout state', () => {
  it('synchronizes collapsed visibility while preserving the last non-zero widths', () => {
    expect(
      commitOuterPanelLayout(
        currentLayout,
        { collapsed: true, width: 0 },
        { collapsed: true, width: 0 }
      )
    ).toEqual({
      ...currentLayout,
      sidebarVisible: false,
      inspectorVisible: false
    })
  })

  it('commits measured widths and expanded visibility', () => {
    expect(
      commitOuterPanelLayout(
        { ...currentLayout, sidebarVisible: false, inspectorVisible: false },
        { collapsed: false, width: 328 },
        { collapsed: false, width: 416 }
      )
    ).toEqual({
      ...currentLayout,
      sidebarWidth: 328,
      inspectorWidth: 416
    })
  })
})
