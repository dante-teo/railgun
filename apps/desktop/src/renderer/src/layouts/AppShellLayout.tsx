import { PanelLeft, PanelRight } from 'lucide-react'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { usePanelRef, type PanelSize } from 'react-resizable-panels'

import { PaneToggle } from '@/components/shell/PaneToggle'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { cn } from '@/lib/utils'
import { commitOuterPanelLayout, resolvePanelWidth } from '@/layouts/app-shell-layout-state'
import {
  readShellLayout,
  SHELL_LAYOUT_CONSTRAINTS,
  type ShellLayoutRecord,
  writeShellLayout
} from '@/layouts/app-shell-storage'

export interface AppShellLayoutProps {
  sidebar: ReactNode
  sidebarTopBar?: ReactNode
  content: ReactNode
  detail?: ReactNode
  workspaceTopBar: ReactNode
  inspector: ReactNode
  inspectorTopBar: ReactNode
}

function getBrowserStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage
}

export function AppShellLayout({
  sidebar,
  sidebarTopBar,
  content,
  detail,
  workspaceTopBar,
  inspector,
  inspectorTopBar
}: AppShellLayoutProps): React.JSX.Element {
  const [layout, setLayout] = useState<ShellLayoutRecord>(() =>
    readShellLayout(getBrowserStorage())
  )
  const layoutRef = useRef(layout)
  const sidebarPanelRef = usePanelRef()
  const contentPanelRef = usePanelRef()
  const inspectorPanelRef = usePanelRef()
  const hasDetail = detail !== undefined

  const updateLayout = useCallback(
    (updater: (current: ShellLayoutRecord) => ShellLayoutRecord, persist = false): void => {
      const next = updater(layoutRef.current)
      layoutRef.current = next
      setLayout(next)

      if (persist) {
        writeShellLayout(getBrowserStorage(), next)
      }
    },
    []
  )

  const persistCurrentPanelWidths = useCallback((): void => {
    updateLayout((current) => {
      const sidebarPanel = sidebarPanelRef.current
      const inspectorPanel = inspectorPanelRef.current
      return commitOuterPanelLayout(
        current,
        {
          collapsed: sidebarPanel?.isCollapsed(),
          width: sidebarPanel?.getSize().inPixels
        },
        {
          collapsed: inspectorPanel?.isCollapsed(),
          width: inspectorPanel?.getSize().inPixels
        }
      )
    }, true)
  }, [inspectorPanelRef, sidebarPanelRef, updateLayout])

  const persistContentWidth = useCallback((): void => {
    updateLayout((current) => {
      const contentWidth = contentPanelRef.current?.getSize().inPixels
      return {
        ...current,
        contentWidth: resolvePanelWidth(contentWidth, current.contentWidth)
      }
    }, true)
  }, [contentPanelRef, updateLayout])

  const handleContentResize = useCallback(
    (size: PanelSize): void => {
      if (size.inPixels <= 0) {
        return
      }

      updateLayout((current) => ({ ...current, contentWidth: size.inPixels }))
    },
    [updateLayout]
  )

  const toggleSidebar = useCallback((): void => {
    const currentLayout = layoutRef.current

    if (currentLayout.sidebarVisible) {
      const currentWidth = resolvePanelWidth(
        sidebarPanelRef.current?.getSize().inPixels,
        currentLayout.sidebarWidth
      )
      sidebarPanelRef.current?.collapse()
      updateLayout(
        (current) => ({
          ...current,
          sidebarWidth: currentWidth,
          sidebarVisible: false
        }),
        true
      )
      return
    }

    sidebarPanelRef.current?.expand()
    sidebarPanelRef.current?.resize(currentLayout.sidebarWidth)
    updateLayout((current) => ({ ...current, sidebarVisible: true }), true)
  }, [sidebarPanelRef, updateLayout])

  const toggleInspector = useCallback((): void => {
    const currentLayout = layoutRef.current

    if (currentLayout.inspectorVisible) {
      const currentWidth = resolvePanelWidth(
        inspectorPanelRef.current?.getSize().inPixels,
        currentLayout.inspectorWidth
      )
      inspectorPanelRef.current?.collapse()
      updateLayout(
        (current) => ({
          ...current,
          inspectorWidth: currentWidth,
          inspectorVisible: false
        }),
        true
      )
      return
    }

    inspectorPanelRef.current?.expand()
    inspectorPanelRef.current?.resize(currentLayout.inspectorWidth)
    updateLayout((current) => ({ ...current, inspectorVisible: true }), true)
  }, [inspectorPanelRef, updateLayout])

  return (
    <main className="h-svh min-h-[720px] min-w-[1280px] overflow-hidden bg-background text-foreground">
      <ResizablePanelGroup
        id="shell-outer-group"
        onLayoutChanged={persistCurrentPanelWidths}
        orientation="horizontal"
      >
        <ResizablePanel
          collapsedSize={0}
          collapsible
          data-default-width={layout.sidebarWidth}
          data-min-width={SHELL_LAYOUT_CONSTRAINTS.sidebar.min}
          defaultSize={layout.sidebarVisible ? layout.sidebarWidth : 0}
          groupResizeBehavior="preserve-pixel-size"
          id="sidebar-panel"
          maxSize={SHELL_LAYOUT_CONSTRAINTS.sidebar.max}
          minSize={SHELL_LAYOUT_CONSTRAINTS.sidebar.min}
          panelRef={sidebarPanelRef}
        >
          <section
            aria-hidden={!layout.sidebarVisible}
            className={cn(
              'flex h-full min-w-0 flex-col bg-sidebar',
              !layout.sidebarVisible && 'invisible'
            )}
            id="shell-sidebar"
          >
            <header
              className="window-drag-region flex h-[52px] shrink-0 items-center"
              data-integrated-with-body="true"
              data-shell-topbar="sidebar"
              data-toggle-layout="flow"
            >
              <div className="min-w-0 flex-1">{sidebarTopBar}</div>
              {layout.sidebarVisible ? (
                <div className="mr-4 shrink-0">
                  <PaneToggle
                    controls="shell-sidebar"
                    expanded
                    icon={PanelLeft}
                    label="Hide sidebar"
                    onToggle={toggleSidebar}
                  />
                </div>
              ) : null}
            </header>
            <div className="min-h-0 flex-1" data-pane-body data-pane-body-start="52">
              {sidebar}
            </div>
          </section>
        </ResizablePanel>

        {layout.sidebarVisible ? <ResizableHandle id="shell-sidebar-handle" /> : null}

        <ResizablePanel
          id="workspace-panel"
          minSize={
            hasDetail
              ? SHELL_LAYOUT_CONSTRAINTS.workspace.minWithDetail
              : SHELL_LAYOUT_CONSTRAINTS.content.min
          }
        >
          <section className="flex h-full min-w-0 flex-col">
            <header
              className="window-drag-region flex h-[52px] shrink-0 items-center border-b bg-background"
              data-shares-content-detail={String(hasDetail)}
              data-shell-topbar="workspace"
              data-toggle-layout="flow"
              data-traffic-light-clearance={String(!layout.sidebarVisible)}
            >
              {!layout.sidebarVisible ? (
                <div className="ml-24 shrink-0">
                  <PaneToggle
                    controls="shell-sidebar"
                    expanded={false}
                    icon={PanelLeft}
                    label="Show sidebar"
                    onToggle={toggleSidebar}
                  />
                </div>
              ) : null}
              <div className="min-w-0 flex-1 self-stretch">{workspaceTopBar}</div>
              {!layout.inspectorVisible ? (
                <div className="ml-3 mr-4 shrink-0">
                  <PaneToggle
                    controls="shell-inspector"
                    expanded={false}
                    icon={PanelRight}
                    label="Show inspector"
                    onToggle={toggleInspector}
                  />
                </div>
              ) : null}
            </header>

            <div className="min-h-0 flex-1" data-workspace-body>
              {hasDetail ? (
                <ResizablePanelGroup
                  id="shell-workspace-group"
                  onLayoutChanged={persistContentWidth}
                  orientation="horizontal"
                >
                  <ResizablePanel
                    data-default-width={layout.contentWidth}
                    data-min-width={SHELL_LAYOUT_CONSTRAINTS.content.min}
                    defaultSize={layout.contentWidth}
                    groupResizeBehavior="preserve-pixel-size"
                    id="content-panel"
                    maxSize={SHELL_LAYOUT_CONSTRAINTS.content.max}
                    minSize={SHELL_LAYOUT_CONSTRAINTS.content.min}
                    onResize={handleContentResize}
                    panelRef={contentPanelRef}
                  >
                    <section
                      className="h-full min-w-0 bg-background"
                      data-fills-workspace="false"
                      data-pane-body
                      data-pane-body-start="52"
                      id="shell-content"
                    >
                      {content}
                    </section>
                  </ResizablePanel>
                  <ResizableHandle id="shell-content-detail-handle" />
                  <ResizablePanel id="detail-panel" minSize={SHELL_LAYOUT_CONSTRAINTS.detail.min}>
                    <section
                      className="h-full min-w-0 bg-canvas"
                      data-pane-body
                      data-pane-body-start="52"
                      id="shell-detail"
                    >
                      {detail}
                    </section>
                  </ResizablePanel>
                </ResizablePanelGroup>
              ) : (
                <section
                  className="h-full min-w-0 bg-background"
                  data-fills-workspace="true"
                  data-pane-body
                  data-pane-body-start="52"
                  id="shell-content"
                >
                  {content}
                </section>
              )}
            </div>
          </section>
        </ResizablePanel>

        {layout.inspectorVisible ? <ResizableHandle id="shell-inspector-handle" /> : null}

        <ResizablePanel
          collapsedSize={0}
          collapsible
          data-default-width={layout.inspectorWidth}
          data-min-width={SHELL_LAYOUT_CONSTRAINTS.inspector.min}
          defaultSize={layout.inspectorVisible ? layout.inspectorWidth : 0}
          groupResizeBehavior="preserve-pixel-size"
          id="inspector-panel"
          maxSize={SHELL_LAYOUT_CONSTRAINTS.inspector.max}
          minSize={SHELL_LAYOUT_CONSTRAINTS.inspector.min}
          panelRef={inspectorPanelRef}
        >
          <aside
            aria-hidden={!layout.inspectorVisible}
            className={cn(
              'flex h-full min-w-0 flex-col bg-background',
              !layout.inspectorVisible && 'invisible'
            )}
            id="shell-inspector"
          >
            <header
              className="window-drag-region flex h-[52px] shrink-0 items-center"
              data-integrated-with-body="true"
              data-shell-topbar="inspector"
              data-toggle-layout="flow"
            >
              <div className="min-w-0 flex-1 self-stretch">{inspectorTopBar}</div>
              {layout.inspectorVisible ? (
                <div className="ml-2 mr-4 shrink-0">
                  <PaneToggle
                    controls="shell-inspector"
                    expanded
                    icon={PanelRight}
                    label="Hide inspector"
                    onToggle={toggleInspector}
                  />
                </div>
              ) : null}
            </header>
            <div className="min-h-0 flex-1" data-pane-body data-pane-body-start="52">
              {inspector}
            </div>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  )
}
