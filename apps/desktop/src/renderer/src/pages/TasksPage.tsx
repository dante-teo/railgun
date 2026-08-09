import { SidebarNavigation } from '@/components/shell/SidebarNavigation'
import {
  InspectorTopBar,
  SidebarTopBar,
  TasksWorkspaceTopBar
} from '@/components/shell/ShellTopBars'
import { TaskDetailPlaceholder } from '@/components/shell/TaskDetailPlaceholder'
import { TaskInspector } from '@/components/shell/TaskInspector'
import { TaskList } from '@/components/shell/TaskList'
import { AppShellLayout } from '@/layouts/AppShellLayout'

export function TasksPage(): React.JSX.Element {
  return (
    <AppShellLayout
      content={<TaskList />}
      detail={<TaskDetailPlaceholder />}
      inspector={<TaskInspector />}
      inspectorTopBar={<InspectorTopBar />}
      sidebar={<SidebarNavigation />}
      sidebarTopBar={<SidebarTopBar />}
      workspaceTopBar={<TasksWorkspaceTopBar />}
    />
  )
}
