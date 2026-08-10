import { useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

import styles from './TurnWorkRow.module.css'

interface TurnWorkRowProps {
  readonly active: boolean
  readonly animateCompletionOnMount?: boolean
  readonly children: React.ReactNode
  readonly completedAt?: number
  readonly hasWork: boolean
  readonly startedAt?: number
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return [
    hours > 0 ? `${hours}h` : '',
    minutes > 0 ? `${minutes}m` : '',
    seconds > 0 || (hours === 0 && minutes === 0) ? `${seconds}s` : ''
  ]
    .filter(Boolean)
    .join(' ')
}

function workedLabel(startedAt?: number, completedAt?: number): string {
  return startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt
    ? `Worked for ${formatDuration(completedAt - startedAt)}`
    : 'Worked'
}

function CompletionCue({
  children,
  enabled
}: {
  children: React.ReactNode
  enabled: boolean
}): React.JSX.Element {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5', enabled && styles.completionCue)}
      data-completion-cue={enabled ? 'true' : undefined}
    >
      {children}
    </span>
  )
}

export function TurnWorkRow({
  active,
  animateCompletionOnMount = false,
  children,
  completedAt,
  hasWork,
  startedAt
}: TurnWorkRowProps): React.JSX.Element {
  const [open, setOpen] = useState(active)
  const [completionCue] = useState(animateCompletionOnMount)
  const label = active ? 'Working…' : workedLabel(startedAt, completedAt)
  const disclosureLabel = active
    ? `${label} ${open ? 'Hide' : 'Show'} work`
    : `${label}. ${open ? 'Hide' : 'Show'} work`

  return (
    <li className="w-full" data-message-role="work">
      {hasWork ? (
        <Collapsible onOpenChange={setOpen} open={open}>
          <CollapsibleTrigger
            aria-label={disclosureLabel}
            className={cn(
              'group flex min-h-8 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-muted-foreground outline-none',
              'focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:text-foreground',
              styles.trigger
            )}
            type="button"
          >
            <CompletionCue enabled={completionCue}>
              <span>{label}</span>
              <ChevronRightIcon
                aria-hidden="true"
                className={cn('size-3.5 shrink-0', styles.chevron)}
              />
            </CompletionCue>
          </CollapsibleTrigger>
          <Separator />
          <CollapsibleContent>
            <ol aria-label="Agent work" className="flex flex-col gap-6 pb-3 pt-3">
              {children}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <div>
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            <CompletionCue enabled={completionCue}>{label}</CompletionCue>
          </div>
          <Separator />
        </div>
      )}
    </li>
  )
}
