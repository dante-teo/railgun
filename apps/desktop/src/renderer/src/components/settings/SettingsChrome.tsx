import {
  Archive,
  BrainCircuit,
  ChevronRight,
  Palette,
  Settings2,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import type { ReactNode } from 'react'

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { settingsCategories, type SettingsCategory } from '@/lib/settings-route'

const categoryIcons: Record<SettingsCategory, LucideIcon> = {
  general: Settings2,
  appearance: Palette,
  personalization: BrainCircuit,
  skills: Sparkles,
  'archived-tasks': Archive
}

export function SettingsCategoryNavigation({
  category,
  onNavigate
}: {
  category: SettingsCategory
  onNavigate: (to: string) => Promise<boolean>
}): React.JSX.Element {
  const navigate = useNavigate()
  return (
    <nav aria-label="Settings categories" className="flex h-full flex-col gap-1 p-3">
      <h1 className="px-2 pb-3 pt-1 text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Settings
      </h1>
      {settingsCategories.map(({ id, label, path }) => {
        const Icon = categoryIcons[id]
        const selected = id === category
        return (
          <Link
            aria-current={selected ? 'page' : undefined}
            className={cn(
              'flex h-10 items-center gap-2 rounded-lg px-2.5 text-sm font-medium transition-[background-color,transform] duration-(--duration-feedback) ease-(--ease-out) active:scale-[0.985]',
              selected ? 'bg-surface-active text-foreground' : 'text-muted-foreground'
            )}
            key={id}
            onClick={(event) => {
              event.preventDefault()
              void onNavigate(path).then((allowed) => {
                if (allowed) navigate(path)
              })
            }}
            to={path}
          >
            <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.7} />
            <span className="truncate">{label}</span>
            <ChevronRight aria-hidden="true" className="ml-auto size-4 opacity-50" />
          </Link>
        )
      })}
    </nav>
  )
}

export function SettingsWorkspaceTopBar({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 items-center px-4 in-data-[traffic-light-clearance=true]:pl-2">
      <span className="truncate text-[15px] font-medium text-muted-foreground">{title}</span>
    </div>
  )
}

export function SettingsDetail({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-8">
        <header className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold leading-tight tracking-[-0.02em]">{title}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
        </header>
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </div>
  )
}

export function SettingsSection({
  title,
  description,
  action,
  children
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  )
}

export function SettingsLoading({ label }: { label: string }): React.JSX.Element {
  return (
    <div aria-label={label} className="flex flex-col gap-3" role="status">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-4/5" />
    </div>
  )
}

export function InlineError({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <p className="text-sm text-destructive" role="alert">
      {children}
    </p>
  )
}
