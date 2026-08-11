import type { LucideIcon } from 'lucide-react'

import { TopBarIconButton } from '@/components/shell/TopBarIconButton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface PaneToggleProps {
  controls: string
  expanded: boolean
  icon: LucideIcon
  label: string
  onToggle: () => void
}

export function PaneToggle({
  controls,
  expanded,
  icon: Icon,
  label,
  onToggle
}: PaneToggleProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TopBarIconButton
          aria-controls={controls}
          aria-expanded={expanded}
          aria-label={label}
          onClick={onToggle}
        >
          <Icon aria-hidden="true" data-icon="inline-start" strokeWidth={1.75} />
        </TopBarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
