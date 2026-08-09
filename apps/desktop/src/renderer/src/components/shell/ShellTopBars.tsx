import { Ellipsis, SquarePen } from 'lucide-react'

import { TopBarIconButton } from '@/components/shell/TopBarIconButton'

export function SidebarTopBar(): React.JSX.Element {
  return <span className="sr-only">Railgun navigation</span>
}

export function TasksWorkspaceTopBar(): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 items-center pl-5 pr-5 in-data-[traffic-light-clearance=true]:pl-2">
      <TopBarIconButton aria-label="Create task">
        <SquarePen aria-hidden="true" data-icon="inline-start" strokeWidth={1.7} />
      </TopBarIconButton>
    </div>
  )
}

export function InspectorTopBar(): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 items-center pl-5">
      <h2 className="truncate text-[17px] font-semibold leading-none tracking-[-0.01em]">
        Inspector
      </h2>
      <TopBarIconButton aria-label="Inspector actions" className="ml-auto">
        <Ellipsis aria-hidden="true" data-icon="inline-start" strokeWidth={2} />
      </TopBarIconButton>
    </div>
  )
}
