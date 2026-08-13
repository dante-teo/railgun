import { useState } from 'react'

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { PopoverHeader, PopoverTitle } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { contextUsagePresentation, type ContextUsageValues } from '@/lib/context-usage-presentation'

const hoverOpenDelayMilliseconds = 450
const hoverCloseDelayMilliseconds = 80

export function ContextRing({ contextWindow, usedTokens }: ContextUsageValues): React.JSX.Element {
  const presentation = contextUsagePresentation({ contextWindow, usedTokens })
  const accessibleMaximum = Math.max(contextWindow, 1)
  const accessibleValue = usedTokens === null ? undefined : Math.min(usedTokens, accessibleMaximum)
  const [open, setOpen] = useState(false)

  return (
    <HoverCard
      closeDelay={hoverCloseDelayMilliseconds}
      onOpenChange={setOpen}
      open={open}
      openDelay={hoverOpenDelayMilliseconds}
    >
      <HoverCardTrigger asChild>
        <span
          aria-label={presentation.accessibilityText}
          aria-valuemax={accessibleMaximum}
          aria-valuemin={0}
          aria-valuenow={accessibleValue}
          aria-valuetext={presentation.accessibilityText}
          className="inline-flex size-7 shrink-0 cursor-default items-center justify-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onBlur={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          role="meter"
          tabIndex={0}
          title={presentation.detailText}
        >
          <svg
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
            data-slot="task-composer-context"
            viewBox="0 0 20 20"
          >
            <circle
              className="fill-none stroke-current opacity-[0.18]"
              cx="10"
              cy="10"
              r="8"
              strokeWidth="2"
            />
            <circle
              className="fill-none stroke-primary transition-[stroke-dashoffset] duration-300 ease-in-out motion-reduce:transition-none"
              cx="10"
              cy="10"
              data-testid="context-ring-indicator"
              pathLength="100"
              r="8"
              strokeDasharray="100"
              strokeDashoffset={100 - presentation.visualPercentage}
              strokeLinecap="round"
              strokeWidth="2"
              transform="rotate(-90 10 10)"
            />
          </svg>
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        align="end"
        className="flex w-64 flex-col gap-3 p-3"
        side="top"
        sideOffset={8}
      >
        <PopoverHeader>
          <PopoverTitle>Context</PopoverTitle>
        </PopoverHeader>
        {presentation.percentage === null ? (
          <p className="text-xs text-muted-foreground">{presentation.detailText}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <Progress
              aria-label="Context window usage"
              max={100}
              value={presentation.visualPercentage}
            />
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-medium text-foreground">{presentation.percentage}% used</span>
              <span className="text-muted-foreground">{presentation.detailText}</span>
            </div>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}
