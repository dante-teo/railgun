import { useEffect, useState } from 'react'
import {
  ArrowUpIcon,
  ChevronDownIcon,
  FileIcon,
  FolderIcon,
  HandIcon,
  PlusIcon,
  ShieldAlertIcon,
  SquareIcon,
  TerminalIcon,
  XIcon
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
import type { ComposerAttachment } from '@/lib/attachment-api'
import type { ApprovalConfiguration, ApprovalMode } from '@/lib/approval-api'
import { useContextUsage } from '@/hooks/use-context-usage'
import { usePresence } from '@/hooks/use-presence'
import type { ModelConfiguration } from '@/lib/model-api'
import { cn } from '@/lib/utils'

import { ContextRing } from './ContextRing'
import styles from './TaskComposer.module.css'

interface TaskComposerProps {
  approvalExpanded?: boolean
  modelExpanded?: boolean
  sending?: boolean
}

type ComposerSelectorProps = {
  busy?: boolean
  disabled?: boolean
  expanded?: boolean
  label: string
  value: string
} & Omit<React.ComponentProps<typeof Button>, 'children' | 'disabled'>

type SendState = 'idle' | 'sending'

interface SendGlyphProps {
  children: React.ReactNode
  state: SendState
}

interface ApprovalModeOption {
  description: string
  icon: typeof HandIcon
  label: string
  mode: ApprovalMode
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

function approvalModeLabel(mode: ApprovalMode): string {
  return approvalModeOptions.find((option) => option.mode === mode)?.label ?? mode
}

function mergeAttachments(
  current: readonly ComposerAttachment[],
  selected: readonly ComposerAttachment[]
): readonly ComposerAttachment[] {
  const existingPaths = new Set(current.map(({ path }) => path))
  return selected.reduce<readonly ComposerAttachment[]>(
    (attachments, attachment) =>
      existingPaths.has(attachment.path) ? attachments : [...attachments, attachment],
    current
  )
}

function AttachmentChip({
  attachment,
  onExited,
  onRemove,
  present
}: {
  attachment: ComposerAttachment
  onExited: (path: string) => void
  onRemove: (path: string) => void
  present: boolean
}): React.JSX.Element | null {
  const AttachmentIcon = attachment.kind === 'folder' ? FolderIcon : FileIcon
  const presence = usePresence(present, () => onExited(attachment.path))

  if (!presence.mounted) {
    return null
  }

  return (
    <li
      aria-hidden={present ? undefined : true}
      className="min-w-0 max-w-52"
      data-present={present}
      data-slot="task-composer-attachment"
      inert={present ? undefined : true}
      onTransitionEnd={presence.handleTransitionEnd}
    >
      <Button
        aria-label={`Remove ${attachment.kind} ${attachment.name}`}
        className="w-full min-w-0"
        onClick={() => onRemove(attachment.path)}
        size="sm"
        title={attachment.path}
        type="button"
        variant="secondary"
      >
        <AttachmentIcon data-icon="inline-start" />
        <span className="truncate">{attachment.name}</span>
        <XIcon data-icon="inline-end" />
      </Button>
    </li>
  )
}

function ComposerAlert({ message }: { message?: string }): React.JSX.Element | null {
  const [displayedMessage, setDisplayedMessage] = useState({ content: message, source: message })
  const present = message !== undefined
  const presence = usePresence(present)

  if (displayedMessage.source !== message) {
    setDisplayedMessage({
      content: message ?? displayedMessage.content,
      source: message
    })
  }
  const content = message ?? displayedMessage.content
  if (!presence.mounted || content === undefined) {
    return null
  }

  return (
    <p
      aria-hidden={present ? undefined : true}
      className="px-2 text-xs text-destructive"
      data-present={present}
      data-slot="task-composer-error"
      inert={present ? undefined : true}
      onTransitionEnd={presence.handleTransitionEnd}
      role="alert"
    >
      {content}
    </p>
  )
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

function ApprovalModeSelector({
  approval,
  busy,
  expanded,
  onModeChange
}: {
  approval?: ApprovalConfiguration
  busy: boolean
  expanded?: boolean
  onModeChange: (mode: string) => void
}): React.JSX.Element {
  const mode = approval?.mode ?? 'manual'

  return (
    <DropdownMenu open={expanded}>
      <DropdownMenuTrigger asChild>
        <ComposerSelector
          busy={busy}
          disabled={busy || !approval}
          expanded={expanded}
          label="Approval mode"
          value={approvalModeLabel(mode)}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72" side="top">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Approval mode</DropdownMenuLabel>
          <DropdownMenuRadioGroup onValueChange={onModeChange} value={mode}>
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

function ModelSelector({
  busy,
  configuration,
  expanded,
  onModelChange
}: {
  busy: boolean
  configuration?: ModelConfiguration
  expanded?: boolean
  onModelChange: (modelId: string) => void
}): React.JSX.Element {
  const activeModel = configuration?.models.find(({ id }) => id === configuration.activeModelId)
  const value = activeModel?.name ?? 'Loading models…'

  return (
    <DropdownMenu open={expanded}>
      <DropdownMenuTrigger asChild>
        <ComposerSelector
          busy={busy}
          disabled={busy || !configuration || configuration.isRunning}
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

function SendGlyph({ children, state }: SendGlyphProps): React.JSX.Element {
  return (
    <span
      className="absolute inset-0 flex items-center justify-center"
      data-glyph={state}
      data-slot="task-composer-send-glyph"
    >
      {children}
    </span>
  )
}

export function TaskComposer({
  approvalExpanded,
  modelExpanded,
  sending = false
}: TaskComposerProps = {}): React.JSX.Element {
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([])
  const [departingAttachmentPaths, setDepartingAttachmentPaths] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [attachmentError, setAttachmentError] = useState<string>()
  const [approval, setApproval] = useState<ApprovalConfiguration>()
  const [approvalBusy, setApprovalBusy] = useState(true)
  const [approvalError, setApprovalError] = useState<string>()
  const [models, setModels] = useState<ModelConfiguration>()
  const [modelBusy, setModelBusy] = useState(true)
  const [modelError, setModelError] = useState<string>()
  const [pickingAttachments, setPickingAttachments] = useState(false)
  const contextUsage = useContextUsage()
  const sendState: SendState = sending ? 'sending' : 'idle'

  useEffect(() => {
    let cancelled = false
    void window.railgun.approval.get().then(
      (configuration) => {
        if (!cancelled) {
          setApproval(configuration)
          setApprovalBusy(false)
        }
      },
      () => {
        if (!cancelled) {
          setApprovalError('Could not load approval mode. Try reopening the task.')
          setApprovalBusy(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.railgun.models.get().then(
      (configuration) => {
        if (!cancelled) {
          setModels(configuration)
          setModelBusy(false)
        }
      },
      () => {
        if (!cancelled) {
          setModelError('Could not load models. Try reopening the task.')
          setModelBusy(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const handleAddAttachment = async (): Promise<void> => {
    if (pickingAttachments) {
      return
    }

    setAttachmentError(undefined)
    setPickingAttachments(true)
    try {
      const selected = await window.railgun.attachments.pick()
      setAttachments((current) => mergeAttachments(current, selected))
    } catch {
      setAttachmentError('Could not add attachments. Try again.')
    } finally {
      setPickingAttachments(false)
    }
  }

  const handleRemoveAttachment = (path: string): void => {
    setDepartingAttachmentPaths((current) =>
      current.has(path) ? current : new Set([...current, path])
    )
  }

  const handleAttachmentExited = (path: string): void => {
    setAttachments((current) => current.filter((attachment) => attachment.path !== path))
    setDepartingAttachmentPaths(
      (current) => new Set([...current].filter((departingPath) => departingPath !== path))
    )
  }

  const handleApprovalModeChange = async (value: string): Promise<void> => {
    const option = approvalModeOptions.find(({ mode }) => mode === value)
    if (!approval || !option || approvalBusy || option.mode === approval.mode) {
      return
    }
    if (option.mode === 'smart' && approval.reviewerModelId === null) {
      setApprovalError('Choose an approval model before enabling auto approval.')
      return
    }

    setApprovalError(undefined)
    setApprovalBusy(true)
    try {
      setApproval(await window.railgun.approval.setMode(option.mode))
    } catch {
      setApprovalError('Could not update approval mode. Try again.')
    } finally {
      setApprovalBusy(false)
    }
  }

  const handleModelChange = async (modelId: string): Promise<void> => {
    const selected = models?.models.find(({ id }) => id === modelId)
    if (!models || !selected || modelBusy || models.isRunning || modelId === models.activeModelId) {
      return
    }

    setModelError(undefined)
    setModelBusy(true)
    try {
      const configuration = await window.railgun.models.select(selected.id)
      setModels(configuration)
      setModelError(configuration.warning ?? undefined)
    } catch {
      setModelError('Could not update the model. Try again.')
    } finally {
      setModelBusy(false)
    }
  }

  return (
    <div
      aria-label="Message composer"
      className={cn('relative isolate w-full rounded-3xl', styles.composer)}
      data-slot="task-composer"
      role="group"
    >
      <div
        aria-hidden="true"
        className="absolute inset-1 z-0 overflow-hidden rounded-[inherit] blur-md"
        data-slot="task-composer-glow"
      >
        <div data-slot="task-composer-spectrum" />
      </div>
      <div
        className="relative z-10 flex w-full flex-col gap-1 rounded-[inherit] bg-card p-2 ring-1 ring-foreground/10"
        data-slot="task-composer-surface"
      >
        <textarea
          aria-label="Message"
          className="min-h-10 max-h-64 w-full resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm leading-6 text-foreground outline-none field-sizing-content placeholder:text-muted-foreground"
          placeholder="Message"
          rows={1}
        />
        {attachments.length > 0 ? (
          <ul aria-label="Attachments" className="flex flex-wrap gap-1 px-1">
            {attachments.map((attachment) => (
              <AttachmentChip
                attachment={attachment}
                key={attachment.path}
                onExited={handleAttachmentExited}
                onRemove={handleRemoveAttachment}
                present={!departingAttachmentPaths.has(attachment.path)}
              />
            ))}
          </ul>
        ) : null}
        <ComposerAlert message={attachmentError} />
        <ComposerAlert message={approvalError} />
        <ComposerAlert message={modelError} />
        <div
          aria-label="Composer controls"
          className="flex items-center gap-1"
          data-slot="task-composer-toolbar"
          role="group"
        >
          <Button
            aria-label="Add attachment"
            disabled={pickingAttachments}
            onClick={() => void handleAddAttachment()}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <PlusIcon data-icon="inline-start" />
          </Button>
          <ApprovalModeSelector
            approval={approval}
            busy={approvalBusy}
            expanded={approvalExpanded}
            onModeChange={(mode) => void handleApprovalModeChange(mode)}
          />
          <span aria-hidden="true" className="flex-1" data-slot="task-composer-spacer" />
          <ContextRing
            contextWindow={contextUsage.contextWindow}
            usedTokens={contextUsage.usedTokens}
          />
          <ModelSelector
            busy={modelBusy}
            configuration={models}
            expanded={modelExpanded}
            onModelChange={(modelId) => void handleModelChange(modelId)}
          />
          <Button
            aria-label={sendState === 'sending' ? 'Stop generation' : 'Send message'}
            className="rounded-full"
            data-composer-send=""
            data-state={sendState}
            size="icon-sm"
            type="button"
          >
            <span aria-hidden="true" className="relative size-4">
              <SendGlyph state="idle">
                <ArrowUpIcon data-icon="inline-start" />
              </SendGlyph>
              <SendGlyph state="sending">
                <SquareIcon className="fill-current" data-icon="inline-start" />
              </SendGlyph>
            </span>
          </Button>
        </div>
      </div>
    </div>
  )
}
