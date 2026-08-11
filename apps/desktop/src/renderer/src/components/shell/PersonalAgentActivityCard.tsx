import { Lightbulb, ListTodo, UsersRound } from 'lucide-react'

import { ActivityRowPresence, ActivityStatus } from '@/components/shell/PersonalAgentActivityMotion'
import { PersonalAgentActivityPopover } from '@/components/shell/PersonalAgentActivityPopover'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PopoverTitle } from '@/components/ui/popover'
import { usePresentSubagents } from '@/hooks/use-present-subagents'
import type {
  ActivitySnapshot,
  AdvisorActivity,
  SubagentActivity,
  SubagentStatus,
  TodoActivity,
  TodoStatus
} from '@/lib/activity-api'

const activityIcons = { advisor: Lightbulb, subagent: UsersRound, tasks: ListTodo }

function statusLabel(status: SubagentStatus | TodoStatus | AdvisorActivity['severity']): string {
  return status === 'in_progress'
    ? 'In progress'
    : `${status.charAt(0).toUpperCase()}${status.slice(1)}`
}

function ActivityIcon({ type }: { type: 'advisor' | 'subagent' | 'tasks' }): React.JSX.Element {
  const Icon = activityIcons[type]
  return (
    <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.7} />
  )
}

function AdvisorRow({ message }: { message: AdvisorActivity | null }): React.JSX.Element {
  return (
    <PersonalAgentActivityPopover
      content={
        <>
          <PopoverTitle>Advisor</PopoverTitle>
          {message ? (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-xs font-medium text-muted-foreground">
                {statusLabel(message.severity)}
              </p>
              <p className="m-0 whitespace-pre-wrap break-words leading-relaxed">{message.text}</p>
            </div>
          ) : (
            <p className="m-0 text-muted-foreground">No advisor message yet.</p>
          )}
        </>
      }
      label="Advisor"
    >
      <ActivityIcon type="advisor" />
      <span className="min-w-0 flex-1 truncate font-medium">Advisor</span>
    </PersonalAgentActivityPopover>
  )
}

function SubagentPreview({ subagent }: { subagent: SubagentActivity }): React.JSX.Element {
  const response = subagent.messages.find((message) => message.role === 'assistant')?.content ?? ''
  return (
    <>
      <PopoverTitle>Subagent</PopoverTitle>
      <div className="flex flex-col gap-2">
        <p className="m-0 text-xs font-medium text-muted-foreground">Delegated goal</p>
        <p className="m-0 whitespace-pre-wrap break-words leading-relaxed">{subagent.goal}</p>
      </div>
      <div className="flex flex-col gap-2">
        <p className="m-0 text-xs font-medium text-muted-foreground">Assistant response</p>
        <p
          aria-live="polite"
          className="m-0 whitespace-pre-wrap break-words leading-relaxed text-muted-foreground"
        >
          {response || (subagent.status === 'running' ? 'Waiting for response…' : 'No response.')}
        </p>
      </div>
    </>
  )
}

function SubagentRow({
  active,
  subagent
}: {
  active: boolean
  subagent: SubagentActivity
}): React.JSX.Element {
  return (
    <PersonalAgentActivityPopover
      active={active}
      content={<SubagentPreview subagent={subagent} />}
      label={`Subagent: ${subagent.goal}`}
      triggerLabel={`${subagent.goal}, ${statusLabel(subagent.status)}`}
    >
      <ActivityIcon type="subagent" />
      <span className="min-w-0 flex-1 truncate">{subagent.goal}</span>
      <ActivityStatus label={statusLabel(subagent.status)} />
    </PersonalAgentActivityPopover>
  )
}

function TasksPreview({ todos }: { todos: readonly TodoActivity[] }): React.JSX.Element {
  return (
    <>
      <PopoverTitle>Tasks</PopoverTitle>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {todos.map((todo) => (
          <li className="flex items-start gap-3" key={todo.id}>
            <span className="min-w-0 flex-1 break-words leading-relaxed">{todo.content}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {statusLabel(todo.status)}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

function TasksRow({
  active,
  todos
}: {
  active: boolean
  todos: readonly TodoActivity[]
}): React.JSX.Element {
  const completed = todos.filter((todo) => todo.status === 'completed').length
  return (
    <PersonalAgentActivityPopover
      active={active}
      content={<TasksPreview todos={todos} />}
      label="Tasks"
      triggerLabel={`Tasks ${completed}/${todos.length}`}
    >
      <ActivityIcon type="tasks" />
      <span className="min-w-0 flex-1 truncate font-medium">Tasks</span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {completed}/{todos.length}
      </span>
    </PersonalAgentActivityPopover>
  )
}

export function PersonalAgentActivityCard({
  snapshot
}: {
  snapshot: ActivitySnapshot
}): React.JSX.Element {
  const hasActiveTodos = snapshot.todos.some(
    (todo) => todo.status === 'pending' || todo.status === 'in_progress'
  )
  const { presentSubagents, removeExitedSubagent } = usePresentSubagents(snapshot.subagents)

  return (
    <Card
      aria-label="Personal agent activity"
      className="gap-0 py-2 shadow-minimal"
      role="region"
      size="sm"
    >
      <CardHeader className="sr-only">
        <CardTitle>Personal agent activity</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-0 px-2">
        <AdvisorRow message={snapshot.advisor} />
        <div className="flex min-h-8 items-center gap-2 px-2 text-[12px] font-medium text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">Subagents</span>
          <span className="shrink-0 font-mono text-[11px]">{snapshot.subagentCount}</span>
        </div>
        {presentSubagents.map(({ present, subagent }) => (
          <ActivityRowPresence
            key={subagent.index}
            kind="subagent"
            onExited={() => removeExitedSubagent(subagent.index)}
            present={present}
          >
            <SubagentRow active={present} subagent={subagent} />
          </ActivityRowPresence>
        ))}
        <ActivityRowPresence kind="tasks" present={hasActiveTodos}>
          <TasksRow active={hasActiveTodos} todos={snapshot.todos} />
        </ActivityRowPresence>
      </CardContent>
    </Card>
  )
}
