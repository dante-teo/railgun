import { memo, useState } from 'react'
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
  FileTextIcon,
  FolderOpenIcon,
  GlobeIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  ScanSearchIcon,
  SearchIcon,
  SquareTerminalIcon,
  UsersIcon,
  WrenchIcon,
  type LucideIcon
} from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { TranscriptToolMessage } from '@/lib/transcript-api'

import styles from './ToolUseRow.module.css'

interface ToolPresentation {
  readonly description: string
  readonly icon: LucideIcon
  readonly label: string
}

const toolPresentations: Readonly<Record<string, ToolPresentation>> = {
  read_file: { label: 'Read File', description: 'Read a local text file', icon: FileTextIcon },
  write_file: {
    label: 'Write File',
    description: 'Write content to a local file',
    icon: FilePenLineIcon
  },
  list_directory: {
    label: 'List Directory',
    description: 'Inspect a local folder',
    icon: FolderOpenIcon
  },
  run_shell_command: {
    label: 'Run Shell Command',
    description: 'Run a local shell command',
    icon: SquareTerminalIcon
  },
  todo: {
    label: 'Update Tasks',
    description: 'Review or update the task list',
    icon: ListTodoIcon
  },
  clarify: {
    label: 'Ask for Clarification',
    description: 'Request additional input from you',
    icon: CircleHelpIcon
  },
  memory_write: {
    label: 'Save Memory',
    description: 'Save information for a future task',
    icon: BrainIcon
  },
  memory_search: {
    label: 'Search Memories',
    description: 'Search saved memories',
    icon: BrainCircuitIcon
  },
  memory_consolidate: {
    label: 'Consolidate Memories',
    description: 'Organize related memories',
    icon: CombineIcon
  },
  cron: {
    label: 'Manage Schedule',
    description: 'Review or update scheduled tasks',
    icon: CalendarClockIcon
  },
  railgun_inspect: {
    label: 'Inspect Railgun',
    description: 'Inspect bounded Railgun diagnostics',
    icon: ScanSearchIcon
  },
  skill_view: {
    label: 'View Skill',
    description: 'Read a skill’s instructions',
    icon: BookOpenIcon
  },
  web_search: { label: 'Search Web', description: 'Search the public web', icon: SearchIcon },
  web_fetch: { label: 'Fetch Web Page', description: 'Read a public web page', icon: GlobeIcon },
  delegate_task: {
    label: 'Delegate Task',
    description: 'Assign work to a bounded subagent',
    icon: UsersIcon
  }
}

function humanizeToolName(name: string): string {
  return name
    .trim()
    .replaceAll(/[_-]+/g, ' ')
    .replaceAll(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase())
}

function presentationFor(name: string): ToolPresentation {
  return (
    toolPresentations[name] ?? {
      label: humanizeToolName(name),
      description: 'Tool activity',
      icon: WrenchIcon
    }
  )
}

function disclosureLabel(label: string, message: TranscriptToolMessage, expanded: boolean): string {
  if (message.running) {
    return `${label}, in progress`
  }
  const status = message.failed ? ', failed' : ''
  return `${label}${status}. ${expanded ? 'Hide' : 'Show'} details`
}

function ToolDetails({
  detail,
  message
}: {
  detail: string
  message: TranscriptToolMessage
}): React.JSX.Element {
  if (message.name !== 'run_shell_command') {
    return (
      <p className="truncate px-2 py-1 text-xs leading-5 text-foreground" data-slot="tool-details">
        {detail}
      </p>
    )
  }

  return (
    <div
      className="flex max-h-56 flex-col gap-2 overflow-auto rounded-lg border bg-muted/40 px-3 py-2.5 font-mono text-xs leading-5"
      data-slot="tool-details"
    >
      <pre aria-label="Shell command" className="whitespace-pre-wrap break-words text-foreground">
        <code>
          <span aria-hidden="true" className="text-muted-foreground">
            $&nbsp;
          </span>
          {message.command ?? detail}
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

export const ToolUseRow = memo(function ToolUseRow({
  message
}: {
  message: TranscriptToolMessage
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const presentation = presentationFor(message.name)
  const Icon = message.failed ? CircleXIcon : presentation.icon
  const detail = message.detail ?? message.target ?? presentation.description
  const expanded = message.running ? true : open

  return (
    <li className="mr-auto w-full max-w-105" data-message-role="tool">
      <Collapsible
        disabled={message.running}
        onOpenChange={(nextOpen) => {
          if (!message.running) {
            setOpen(nextOpen)
          }
        }}
        open={expanded}
      >
        <CollapsibleTrigger
          aria-label={disclosureLabel(presentation.label, message, expanded)}
          className={cn(
            'group flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-muted-foreground outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:text-foreground',
            styles.trigger,
            message.failed && 'text-destructive data-[state=open]:text-destructive'
          )}
          data-failed={message.failed}
          type="button"
        >
          <Icon
            aria-hidden="true"
            className="size-4"
            data-failure-indicator={message.failed ? 'true' : undefined}
          />
          <span className="truncate">{presentation.label}</span>
          {message.running ? (
            <LoaderCircleIcon
              aria-label="In progress"
              className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            />
          ) : (
            <ChevronRightIcon
              aria-hidden="true"
              className={cn('size-3.5 shrink-0', styles.chevron)}
            />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="pl-8 pt-2">
          <ToolDetails detail={detail} message={message} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
})
