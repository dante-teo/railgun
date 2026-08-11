import type { TranscriptMessage, TranscriptToolMessage } from '@/lib/transcript-api'

const exploratoryTools = new Set([
  'read_file',
  'list_directory',
  'web_search',
  'web_fetch',
  'memory_search',
  'railgun_inspect'
])

interface ExplorationDisplayRow {
  readonly id: string
  readonly kind: 'exploration'
  readonly messages: readonly TranscriptToolMessage[]
}

interface MessageDisplayRow {
  readonly id: string
  readonly kind: 'message'
  readonly message: TranscriptMessage
}

export type TranscriptDisplayRow = ExplorationDisplayRow | MessageDisplayRow

function isExploratory(message: TranscriptMessage): message is TranscriptToolMessage {
  return message.role === 'tool' && exploratoryTools.has(message.name)
}

export function transcriptDisplayRows(
  messages: readonly TranscriptMessage[]
): readonly TranscriptDisplayRow[] {
  return messages.reduce<readonly TranscriptDisplayRow[]>((rows, message) => {
    if (!isExploratory(message)) {
      return [...rows, { id: message.id, kind: 'message', message }]
    }
    const previous = rows.at(-1)
    return previous?.kind === 'exploration'
      ? [...rows.slice(0, -1), { ...previous, messages: [...previous.messages, message] }]
      : [...rows, { id: `exploration-${message.id}`, kind: 'exploration', messages: [message] }]
  }, [])
}

export function humanizeToolName(name: string): string {
  return name
    .trim()
    .replaceAll(/[_-]+/g, ' ')
    .replaceAll(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase())
}

export function basename(value?: string): string | undefined {
  return value?.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)
}

function fileActionLabel(verb: string, target?: string): string {
  return `${verb} ${basename(target) ?? 'file'}`
}

function scheduleActionLabel(detail?: string): string {
  switch (detail) {
    case 'Scheduled tasks':
      return 'Checked schedules'
    case 'Add scheduled task':
      return 'Scheduled task'
    case 'Update scheduled task':
      return 'Updated schedule'
    case 'Remove scheduled task':
      return 'Removed schedule'
    default:
      return 'Checked schedules'
  }
}

export function toolActionLabel(message: TranscriptToolMessage): string {
  switch (message.name) {
    case 'read_file':
    case 'list_directory':
    case 'web_search':
    case 'web_fetch':
    case 'memory_search':
    case 'railgun_inspect':
      return 'Explored'
    case 'run_shell_command':
      return 'Ran command'
    case 'create_file':
      return fileActionLabel('Created', message.target)
    case 'write_file':
      return fileActionLabel('Wrote', message.target)
    case 'delete_file':
      return fileActionLabel('Deleted', message.target)
    case 'todo':
      return message.detail === 'Current task list' ? 'Reviewed tasks' : 'Updated tasks'
    case 'clarify':
      return 'Asked for clarification'
    case 'memory_write':
      return 'Remembered'
    case 'memory_consolidate':
      return 'Organized memories'
    case 'cron':
      return scheduleActionLabel(message.detail)
    case 'skill_view':
      return 'Used skill'
    case 'delegate_task':
      return 'Delegated tasks'
    default:
      return humanizeToolName(message.name)
  }
}

export function explorationChildLabel(message: TranscriptToolMessage): string {
  switch (message.name) {
    case 'read_file':
      return fileActionLabel('Read', message.target)
    case 'list_directory':
      return fileActionLabel('Listed', message.target ?? 'directory')
    case 'web_search':
      return 'Searched the web'
    case 'web_fetch':
      return 'Fetched a web page'
    case 'memory_search':
      return 'Searched memories'
    case 'railgun_inspect':
      return 'Inspected Railgun'
    default:
      return humanizeToolName(message.name)
  }
}
