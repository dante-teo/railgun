import { memo, useState, type ReactNode } from 'react'
import {
  BookOpenIcon,
  BrainCircuitIcon,
  BrainIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  CircleXIcon,
  CombineIcon,
  FilePenLineIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderOpenIcon,
  GlobeIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  ScanSearchIcon,
  SearchIcon,
  SquareTerminalIcon,
  Trash2Icon,
  UsersIcon,
  WrenchIcon,
  type LucideIcon
} from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { TranscriptToolMessage } from '@/lib/transcript-api'

import styles from './ToolUseRow.module.css'
import { basename, explorationChildLabel, toolActionLabel } from './tool-activity'

interface ToolPresentation {
  readonly description: string
  readonly icon: LucideIcon
}

const toolPresentations: Readonly<Record<string, ToolPresentation>> = {
  read_file: { description: 'Read a local text file', icon: FileTextIcon },
  create_file: { description: 'Create or replace a local file', icon: FilePlusIcon },
  write_file: { description: 'Write content to a local file', icon: FilePenLineIcon },
  delete_file: { description: 'Permanently delete a local file', icon: Trash2Icon },
  list_directory: { description: 'Inspect a local folder', icon: FolderOpenIcon },
  run_shell_command: { description: 'Run a local shell command', icon: SquareTerminalIcon },
  todo: { description: 'Review or update the task list', icon: ListTodoIcon },
  clarify: { description: 'Request additional input from you', icon: CircleHelpIcon },
  memory_write: { description: 'Save information for a future task', icon: BrainIcon },
  memory_search: { description: 'Search saved memories', icon: BrainCircuitIcon },
  memory_consolidate: { description: 'Organize related memories', icon: CombineIcon },
  cron: { description: 'Review or update scheduled tasks', icon: CalendarClockIcon },
  railgun_inspect: { description: 'Inspect bounded Railgun diagnostics', icon: ScanSearchIcon },
  skill_view: { description: 'Read a skill’s instructions', icon: BookOpenIcon },
  web_search: { description: 'Search the public web', icon: SearchIcon },
  web_fetch: { description: 'Read a public web page', icon: GlobeIcon },
  delegate_task: { description: 'Assign work to bounded subagents', icon: UsersIcon }
}

function presentationFor(name: string): ToolPresentation {
  return toolPresentations[name] ?? { description: 'Tool activity', icon: WrenchIcon }
}

function disclosureLabel(label: string, failed: boolean, running: boolean, open: boolean): string {
  if (running) {
    return `${label}, in progress`
  }
  return `${label}${failed ? ', failed' : ''}. ${open ? 'Hide' : 'Show'} details`
}

function PrimaryIcon({
  failed,
  icon: CategoryIcon,
  replaceFailedIcon
}: {
  readonly failed: boolean
  readonly icon: LucideIcon
  readonly replaceFailedIcon: boolean
}): React.JSX.Element {
  if (!replaceFailedIcon) {
    return <CategoryIcon aria-hidden="true" className="size-4 shrink-0" />
  }

  return (
    <span aria-hidden="true" className="relative size-4 shrink-0">
      <span
        className={cn('absolute inset-0 grid place-items-center', styles.statusIcon)}
        data-visible={!failed}
      >
        <CategoryIcon className="size-full" />
      </span>
      <span
        className={cn('absolute inset-0 grid place-items-center', styles.statusIcon)}
        data-slot="failure-indicator"
        data-visible={failed}
      >
        <CircleXIcon className="size-full" data-failure-indicator={failed ? 'true' : undefined} />
      </span>
    </span>
  )
}

function DisclosureRow({
  children,
  failed,
  icon: CategoryIcon,
  label,
  replaceFailedIcon = true,
  resetKey,
  running
}: {
  readonly children: ReactNode
  readonly failed: boolean
  readonly icon: LucideIcon
  readonly label: string
  readonly replaceFailedIcon?: boolean
  readonly resetKey: string
  readonly running: boolean
}): React.JSX.Element {
  const [disclosure, setDisclosure] = useState(() => ({ open: false, resetKey }))
  const open = disclosure.resetKey === resetKey && disclosure.open
  const expanded = running || open

  return (
    <li className="mr-auto w-full max-w-105" data-message-role="tool">
      <Collapsible
        disabled={running}
        onOpenChange={(nextOpen) => {
          if (!running) {
            setDisclosure({ open: nextOpen, resetKey })
          }
        }}
        open={expanded}
      >
        <CollapsibleTrigger
          aria-label={disclosureLabel(label, failed, running, expanded)}
          className={cn(
            'group flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-muted-foreground outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:text-foreground',
            styles.trigger,
            failed && 'text-destructive data-[state=open]:text-destructive'
          )}
          data-failed={failed}
          type="button"
        >
          <PrimaryIcon failed={failed} icon={CategoryIcon} replaceFailedIcon={replaceFailedIcon} />
          <span className="truncate">{label}</span>
          <span
            className={cn('flex shrink-0 items-center', !replaceFailedIcon && failed && 'gap-2')}
            data-slot="tool-row-end-controls"
          >
            {!replaceFailedIcon ? (
              <span
                aria-hidden="true"
                className={cn(
                  'grid h-3.5 shrink-0 place-items-center overflow-hidden',
                  failed ? 'w-3.5' : 'w-0',
                  styles.statusIcon
                )}
                data-slot="failure-indicator"
                data-visible={failed}
              >
                <CircleXIcon
                  className="size-full"
                  data-failure-indicator={failed ? 'true' : undefined}
                />
              </span>
            ) : null}
            {running ? (
              <span
                aria-label="In progress"
                className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                role="status"
              >
                <LoaderCircleIcon aria-hidden="true" className="size-full" />
              </span>
            ) : (
              <span aria-hidden="true" className={cn('size-3.5 shrink-0', styles.chevron)}>
                <ChevronRightIcon className="size-full" />
              </span>
            )}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="pl-8 pt-2">{children}</CollapsibleContent>
      </Collapsible>
    </li>
  )
}

export const ExplorationGroupRow = memo(function ExplorationGroupRow({
  messages
}: {
  readonly messages: readonly TranscriptToolMessage[]
}): React.JSX.Element {
  const failed = messages.some((message) => message.failed)
  const running = messages.some((message) => message.running)
  const lastMessageId = messages.at(-1)?.id ?? 'empty'

  return (
    <DisclosureRow
      failed={failed}
      icon={ScanSearchIcon}
      label="Explored"
      replaceFailedIcon={false}
      resetKey={`${lastMessageId}:${running ? 'running' : 'completed'}`}
      running={running}
    >
      <ul aria-label="Exploration details" className="flex flex-col gap-1 px-2 py-1">
        {messages.map((message) => {
          const presentation = presentationFor(message.name)
          const Icon = message.failed ? CircleXIcon : presentation.icon
          return (
            <li
              className={cn(
                'flex min-h-6 items-center gap-2 text-xs leading-5 text-foreground',
                styles.explorationChild,
                message.failed && 'text-destructive'
              )}
              data-live={message.running === true ? 'true' : undefined}
              key={message.id}
            >
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="break-words">{explorationChildLabel(message)}</span>
              {message.failed ? <span className="font-medium">Failed</span> : null}
            </li>
          )
        })}
      </ul>
    </DisclosureRow>
  )
})

function FileChangeDetails({ message }: { message: TranscriptToolMessage }): React.JSX.Element {
  if (message.running) {
    return (
      <p className="px-2 py-1 text-xs leading-5 text-muted-foreground" data-slot="tool-details">
        Preparing file change…
      </p>
    )
  }
  const change = message.fileChange
  if (!change || change.status === 'unavailable') {
    return (
      <p className="px-2 py-1 text-xs leading-5 text-muted-foreground" data-slot="tool-details">
        Diff unavailable
      </p>
    )
  }
  if (change.status === 'unchanged') {
    return (
      <p className="px-2 py-1 text-xs leading-5 text-muted-foreground" data-slot="tool-details">
        No content changes
      </p>
    )
  }
  if (!change.diff) {
    return (
      <p className="px-2 py-1 text-xs leading-5 text-muted-foreground" data-slot="tool-details">
        {message.name === 'create_file' ? 'Created an empty file' : 'Diff unavailable'}
      </p>
    )
  }
  const target = basename(message.target) ?? 'file'
  return (
    <div className="flex flex-col gap-1.5" data-slot="tool-details">
      <pre
        aria-label={`Diff for ${target}`}
        className="max-h-72 overflow-auto rounded-lg border bg-muted/40 px-3 py-2.5 font-mono text-xs leading-5 text-foreground"
      >
        <code>{change.diff}</code>
      </pre>
      {change.truncated ? (
        <p className="px-2 text-xs leading-5 text-muted-foreground">Diff truncated</p>
      ) : null}
    </div>
  )
}

function ToolDetails({ message }: { message: TranscriptToolMessage }): React.JSX.Element {
  if (message.name === 'create_file' || message.name === 'write_file') {
    return <FileChangeDetails message={message} />
  }
  if (message.name === 'run_shell_command') {
    return (
      <div
        className="flex max-h-56 flex-col gap-2 overflow-auto px-2 py-1 font-mono text-xs leading-5"
        data-slot="tool-details"
      >
        <pre aria-label="Shell command" className="whitespace-pre-wrap break-words text-foreground">
          <code>
            <span aria-hidden="true" className="text-muted-foreground">
              $&nbsp;
            </span>
            {message.command ?? 'Command unavailable'}
          </code>
        </pre>
        <pre
          aria-label="Shell output"
          className="whitespace-pre-wrap break-words text-muted-foreground"
        >
          {message.output ?? (message.running ? 'Running…' : 'No output')}
        </pre>
      </div>
    )
  }
  const presentation = presentationFor(message.name)
  return (
    <p className="break-words px-2 py-1 text-xs leading-5 text-foreground" data-slot="tool-details">
      {message.detail ?? basename(message.target) ?? presentation.description}
    </p>
  )
}

export const ToolUseRow = memo(function ToolUseRow({
  message
}: {
  readonly message: TranscriptToolMessage
}): React.JSX.Element {
  const presentation = presentationFor(message.name)
  return (
    <DisclosureRow
      failed={message.failed}
      icon={presentation.icon}
      label={toolActionLabel(message)}
      resetKey={`${message.id}:${message.running ? 'running' : 'completed'}`}
      running={message.running === true}
    >
      <ToolDetails message={message} />
    </DisclosureRow>
  )
})
