import {
  ChevronDownIcon,
  HandIcon,
  ShieldAlertIcon,
  TerminalIcon,
  type LucideIcon
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { ApprovalConfiguration, ApprovalMode } from '@/lib/approval-api'
import type { ModelConfiguration } from '@/lib/model-api'

interface ComposerSelectorProps extends Omit<
  React.ComponentProps<typeof Button>,
  'children' | 'disabled'
> {
  busy?: boolean
  disabled?: boolean
  expanded?: boolean
  label: string
  value: string
}

interface ApprovalModeOption {
  description: string
  icon: LucideIcon
  label: string
  mode: ApprovalMode
}

interface ApprovalModeSelectorProps {
  approval?: ApprovalConfiguration
  busy: boolean
  disabled: boolean
  expanded?: boolean
  onModeChange: (mode: ApprovalMode) => void
}

interface ModelSelectorProps {
  busy: boolean
  configuration?: ModelConfiguration
  disabled: boolean
  expanded?: boolean
  onModelChange: (modelId: string) => void
}

const approvalModeOptions: readonly ApprovalModeOption[] = [
  {
    description: 'Confirm flagged commands before they run.',
    icon: HandIcon,
    label: 'Ask for approval',
    mode: 'manual'
  },
  {
    description: 'Let the selected approval model review flagged commands.',
    icon: TerminalIcon,
    label: 'Approve for me',
    mode: 'smart'
  },
  {
    description: 'Run flagged commands without asking.',
    icon: ShieldAlertIcon,
    label: 'Full access',
    mode: 'off'
  }
]

function parseApprovalMode(value: string): ApprovalMode | undefined {
  return approvalModeOptions.find(({ mode }) => mode === value)?.mode
}

function approvalModeLabel(mode: ApprovalMode): string {
  return approvalModeOptions.find((option) => option.mode === mode)?.label ?? mode
}

function ComposerSelector({
  busy,
  disabled,
  expanded,
  label,
  value,
  ...triggerProps
}: ComposerSelectorProps): React.JSX.Element {
  return (
    <Button
      aria-label={`${label}: ${value}`}
      aria-busy={busy || undefined}
      data-composer-selector=""
      disabled={disabled}
      size="sm"
      type="button"
      variant="ghost"
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
      {...triggerProps}
    >
      {value}
      <span aria-hidden="true" data-slot="task-composer-selector-indicator">
        <ChevronDownIcon data-icon="inline-end" />
      </span>
    </Button>
  )
}

export function ApprovalModeSelector({
  approval,
  busy,
  disabled,
  expanded,
  onModeChange
}: ApprovalModeSelectorProps): React.JSX.Element {
  const mode = approval?.mode ?? 'manual'
  const handleModeChange = (value: string): void => {
    const nextMode = parseApprovalMode(value)
    if (nextMode) {
      onModeChange(nextMode)
    }
  }

  return (
    <DropdownMenu open={expanded}>
      <DropdownMenuTrigger asChild>
        <ComposerSelector
          busy={busy}
          disabled={disabled || busy || !approval}
          expanded={expanded}
          label="Approval mode"
          value={approvalModeLabel(mode)}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72" side="top">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Approval mode</DropdownMenuLabel>
          <DropdownMenuRadioGroup onValueChange={handleModeChange} value={mode}>
            {approvalModeOptions.map((option) => {
              const ModeIcon = option.icon
              return (
                <DropdownMenuRadioItem
                  className="items-start py-2"
                  key={option.mode}
                  value={option.mode}
                >
                  <ModeIcon className="mt-0.5 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  </span>
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ModelSelector({
  busy,
  configuration,
  disabled,
  expanded,
  onModelChange
}: ModelSelectorProps): React.JSX.Element {
  const activeModel = configuration?.models.find(({ id }) => id === configuration.activeModelId)
  const value = activeModel?.name ?? 'Loading models…'

  return (
    <DropdownMenu open={expanded}>
      <DropdownMenuTrigger asChild>
        <ComposerSelector
          busy={busy}
          disabled={disabled || busy || !configuration || configuration.isRunning}
          expanded={expanded}
          label="Select model"
          value={value}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" side="top">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={onModelChange}
            value={configuration?.activeModelId}
          >
            {configuration?.models.map((model) => (
              <DropdownMenuRadioItem key={model.id} value={model.id}>
                {model.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
