import { CalendarDays, CheckSquare2, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { PersonalAgentActivityCard } from '@/components/shell/PersonalAgentActivityCard'
import type { ActivitySnapshot } from '@/lib/activity-api'
import { cn } from '@/lib/utils'

interface NavigationRowProps {
  icon: LucideIcon
  label: string
  selected?: boolean
}

function NavigationRow({
  icon: Icon,
  label,
  selected = false
}: NavigationRowProps): React.JSX.Element {
  return (
    <div
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'flex h-11 items-center gap-2 rounded-md px-3 text-[15px] font-medium text-foreground',
        selected && 'bg-surface-active'
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn('size-[19px] shrink-0', selected ? 'text-primary' : 'text-muted-foreground')}
        strokeWidth={1.65}
      />
      <span>{label}</span>
    </div>
  )
}

export function SidebarNavigation({ activity }: { activity: ActivitySnapshot }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col px-3 pb-3 pt-4">
      <nav aria-label="Primary" className="flex flex-col gap-2">
        <NavigationRow icon={CheckSquare2} label="Tasks" selected />
        <NavigationRow icon={CalendarDays} label="Scheduled" />
        <NavigationRow icon={Settings} label="Settings" />
      </nav>
      <div className="mt-auto pt-4">
        <PersonalAgentActivityCard snapshot={activity} />
      </div>
    </div>
  )
}
