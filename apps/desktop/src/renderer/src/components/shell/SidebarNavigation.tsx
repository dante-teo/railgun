import { CalendarDays, CheckSquare2, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Link, useInRouterContext, useNavigate } from 'react-router'

import { PersonalAgentActivityCard } from '@/components/shell/PersonalAgentActivityCard'
import type { ActivitySnapshot } from '@/lib/activity-api'
import { cn } from '@/lib/utils'

interface NavigationRowProps {
  icon: LucideIcon
  label: string
  selected?: boolean
  to?: string
  onNavigate?: (to: string) => Promise<boolean>
}

interface RouteNavigationLinkProps {
  children: React.ReactNode
  className: string
  onNavigate?: (to: string) => Promise<boolean>
  selected: boolean
  to: string
}

function RouteNavigationLink({
  children,
  className,
  onNavigate,
  selected,
  to
}: RouteNavigationLinkProps): React.JSX.Element {
  const navigate = useNavigate()

  return (
    <Link
      aria-current={selected ? 'page' : undefined}
      className={className}
      onClick={
        onNavigate
          ? (event) => {
              event.preventDefault()
              void onNavigate(to).then((allowed) => {
                if (allowed) navigate(to)
              })
            }
          : undefined
      }
      to={to}
    >
      {children}
    </Link>
  )
}

function NavigationRow({
  icon: Icon,
  label,
  selected = false,
  to,
  onNavigate
}: NavigationRowProps): React.JSX.Element {
  const isInRouter = useInRouterContext()
  const content = (
    <>
      <Icon
        aria-hidden="true"
        className={cn('size-[19px] shrink-0', selected ? 'text-primary' : 'text-muted-foreground')}
        strokeWidth={1.65}
      />
      <span>{label}</span>
    </>
  )
  const className = cn(
    'flex h-11 items-center gap-2 rounded-md px-3 text-[15px] font-medium text-foreground transition-[background-color,transform] duration-(--duration-feedback) ease-(--ease-out) active:scale-[0.985]',
    selected && 'bg-surface-active'
  )

  return to && isInRouter ? (
    <RouteNavigationLink className={className} onNavigate={onNavigate} selected={selected} to={to}>
      {content}
    </RouteNavigationLink>
  ) : to ? (
    <a
      aria-current={selected ? 'page' : undefined}
      className={className}
      href={`#${to}`}
      onClick={
        onNavigate
          ? (event) => {
              event.preventDefault()
              void onNavigate(to).then((allowed) => {
                if (allowed) window.location.hash = to
              })
            }
          : undefined
      }
    >
      {content}
    </a>
  ) : (
    <div className={className}>{content}</div>
  )
}

export function SidebarNavigation({
  activity,
  onNavigate,
  selected = 'tasks'
}: {
  activity: ActivitySnapshot
  onNavigate?: (to: string) => Promise<boolean>
  selected?: 'tasks' | 'settings'
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col px-3 pb-3 pt-4">
      <nav aria-label="Primary" className="flex flex-col gap-2">
        <NavigationRow
          icon={CheckSquare2}
          label="Tasks"
          onNavigate={onNavigate}
          selected={selected === 'tasks'}
          to="/"
        />
        <NavigationRow icon={CalendarDays} label="Scheduled" />
        <NavigationRow
          icon={Settings}
          label="Settings"
          onNavigate={onNavigate}
          selected={selected === 'settings'}
          to="/settings/general"
        />
      </nav>
      <div className="mt-auto pt-4">
        <PersonalAgentActivityCard snapshot={activity} />
      </div>
    </div>
  )
}
