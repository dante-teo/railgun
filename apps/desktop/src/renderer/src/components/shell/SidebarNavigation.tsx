import { CalendarDays, CheckSquare2, EllipsisVertical, Monitor, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
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
        'flex h-11 items-center gap-3 rounded-md px-3 text-[15px] font-medium text-foreground',
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

function SidecarStatus(): React.JSX.Element {
  return (
    <section className="flex items-center gap-3 rounded-lg border bg-card p-3 shadow-minimal">
      <Monitor
        aria-hidden="true"
        className="size-5 shrink-0 text-muted-foreground"
        strokeWidth={1.6}
      />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[14px] font-medium">Sidecar</h2>
        <p className="mt-0.5 flex items-center gap-2 text-[12px] text-muted-foreground">
          Connected
          <span aria-label="Online" className="size-2 rounded-full bg-primary" role="img" />
        </p>
      </div>
      <Button aria-label="Sidecar actions" size="icon-sm" type="button" variant="ghost">
        <EllipsisVertical aria-hidden="true" data-icon="inline-start" strokeWidth={1.8} />
      </Button>
    </section>
  )
}

export function SidebarNavigation(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col px-3 pb-3 pt-4">
      <nav aria-label="Primary" className="flex flex-col gap-1">
        <NavigationRow icon={CheckSquare2} label="Tasks" selected />
        <NavigationRow icon={CalendarDays} label="Scheduled" />
        <NavigationRow icon={Settings} label="Settings" />
      </nav>
      <div className="mt-auto border-t pt-4">
        <SidecarStatus />
      </div>
    </div>
  )
}
