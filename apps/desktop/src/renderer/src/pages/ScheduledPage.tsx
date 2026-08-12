import { ScheduledJobsWorkspace } from '@/components/scheduled/ScheduledJobsWorkspace'
import { SidebarNavigation } from '@/components/shell/SidebarNavigation'
import { ScheduledWorkspaceTopBar, SidebarTopBar } from '@/components/shell/ShellTopBars'
import { useActivity } from '@/hooks/use-activity'
import { AppShellLayout } from '@/layouts/AppShellLayout'

export function ScheduledPage(): React.JSX.Element {
  const activity = useActivity()
  return (
    <AppShellLayout
      content={<ScheduledJobsWorkspace />}
      sidebar={<SidebarNavigation activity={activity} selected="scheduled" />}
      sidebarTopBar={<SidebarTopBar />}
      workspaceTopBar={<ScheduledWorkspaceTopBar />}
    />
  )
}
