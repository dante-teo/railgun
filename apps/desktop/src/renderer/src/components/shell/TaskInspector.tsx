import {
  Activity,
  CalendarDays,
  Clock3,
  File,
  Folder,
  Link2,
  List,
  Pencil,
  Tag,
  UserRound
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

interface InspectorRowProps {
  icon: LucideIcon
  label: string
  mono?: boolean
  value: string
}

interface InspectorSectionProps {
  rows: readonly InspectorRowProps[]
  title: string
}

const INSPECTOR_SECTIONS: readonly InspectorSectionProps[] = [
  {
    title: 'Context',
    rows: [
      { icon: CalendarDays, label: 'Due date', value: 'Today' },
      { icon: Tag, label: 'Priority', value: 'Normal' },
      { icon: Tag, label: 'Tags', value: '—' },
      { icon: UserRound, label: 'Assignee', value: 'Unassigned' }
    ]
  },
  {
    title: 'Activity',
    rows: [
      { icon: Clock3, label: 'Created', value: 'May 26, 9:41 AM' },
      { icon: Pencil, label: 'Updated', value: 'May 26, 9:41 AM' },
      { icon: Activity, label: 'Status', value: 'ready', mono: true }
    ]
  },
  {
    title: 'Properties',
    rows: [
      { icon: List, label: 'Source', value: 'Manual' },
      { icon: Folder, label: 'Project', value: '—' },
      { icon: Link2, label: 'References', value: '—' },
      { icon: File, label: 'ID', value: 'TSK-0001', mono: true },
      { icon: File, label: 'Path', value: '~/railgun/tasks/draft.md', mono: true }
    ]
  }
]

function InspectorRow({
  icon: Icon,
  label,
  mono = false,
  value
}: InspectorRowProps): React.JSX.Element {
  return (
    <div className="grid min-h-[52px] grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] items-center border-b text-[13px]">
      <div className="flex min-w-0 items-center gap-3 text-muted-foreground">
        <Icon aria-hidden="true" className="size-[17px] shrink-0" strokeWidth={1.55} />
        <span className="truncate">{label}</span>
      </div>
      <span
        className={cn(
          'truncate text-muted-foreground',
          mono && 'w-fit max-w-full rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[12px]'
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

function InspectorSection({ rows, title }: InspectorSectionProps): React.JSX.Element {
  return (
    <section>
      <h2 className="mb-2 text-[14px] font-semibold">{title}</h2>
      {rows.map((row) => (
        <InspectorRow key={`${title}-${row.label}`} {...row} />
      ))}
    </section>
  )
}

export function TaskInspector(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col gap-7 overflow-y-auto px-5 py-7">
      {INSPECTOR_SECTIONS.map((section) => (
        <InspectorSection key={section.title} {...section} />
      ))}
    </div>
  )
}
