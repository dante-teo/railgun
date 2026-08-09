import type { ShellLayoutRecord } from '@/layouts/app-shell-storage'

export interface OuterPanelSnapshot {
  readonly collapsed: boolean | undefined
  readonly width: number | undefined
}

export function resolvePanelWidth(
  measuredWidth: number | undefined,
  fallbackWidth: number
): number {
  return measuredWidth !== undefined && measuredWidth > 0 ? measuredWidth : fallbackWidth
}

function resolvePanelVisibility(collapsed: boolean | undefined, fallbackVisible: boolean): boolean {
  return collapsed === undefined ? fallbackVisible : !collapsed
}

export function commitOuterPanelLayout(
  current: ShellLayoutRecord,
  sidebar: OuterPanelSnapshot,
  inspector: OuterPanelSnapshot
): ShellLayoutRecord {
  return {
    ...current,
    sidebarWidth: resolvePanelWidth(sidebar.width, current.sidebarWidth),
    inspectorWidth: resolvePanelWidth(inspector.width, current.inspectorWidth),
    sidebarVisible: resolvePanelVisibility(sidebar.collapsed, current.sidebarVisible),
    inspectorVisible: resolvePanelVisibility(inspector.collapsed, current.inspectorVisible)
  }
}
