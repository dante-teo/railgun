import type {
  ActivitySnapshot,
  ActivityUpdate,
  AdvisorActivity,
  AdvisorSeverity,
  SubagentActivity,
  TodoActivity,
  TodoStatus
} from '../shared/activity-api.ts'
import { emptyActivitySnapshot } from '../shared/activity-api.ts'

const advisorTextLimit = 2_000
const goalTextLimit = 2_000
const responseTextLimit = 20_000
const todoTextLimit = 2_000
const idTextLimit = 256
const todoLimit = 256
const subagentLimit = 32
const runIdTextLimit = 256
const defaultStreamBroadcastIntervalMilliseconds = 50
const todoStatuses: readonly TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

type ActivityAction =
  | { type: 'run-started'; runId: string | undefined }
  | { type: 'run-ended'; runId: string | undefined }
  | { type: 'advisor'; advisor: AdvisorActivity; runId: string | undefined }
  | { type: 'subagent-started'; goal: string; index: number; count: number }
  | { type: 'subagent-updated'; index: number; delta: string }
  | {
      type: 'subagent-ended'
      goal: string
      index: number
      result: string
      status: SubagentActivity['status']
    }
  | { type: 'todos'; todos: readonly TodoActivity[] }

export interface ActivityBackend {
  request(command: string, fields?: Record<string, unknown>): Promise<unknown>
  subscribeFrames(listener: (frame: Record<string, unknown>) => void): () => void
}

export interface ActivityServiceOptions {
  streamBroadcastIntervalMilliseconds?: number
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}

function requiredText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const text = bounded(value.trim(), limit)
  return text || undefined
}

function boundedText(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? bounded(value, limit) : undefined
}

function optionalRunId(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined
  }
  return typeof value === 'string' && value === value.trim() && value.length <= runIdTextLimit
    ? value || null
    : null
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === 'string' && todoStatuses.includes(value as TodoStatus)
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function parseAdvisor(value: unknown): AdvisorActivity | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const match =
    /^\s*<advisory\b[^>]*\bseverity=["'](nit|concern|blocker)["'][^>]*>(.*?)<\/advisory>\s*$/is.exec(
      value
    )
  if (!match) {
    return undefined
  }
  const severity = match[1].toLowerCase() as AdvisorSeverity
  const text = requiredText(decodeXmlText(match[2]), advisorTextLimit)
  return text ? { severity, text } : undefined
}

function parseTodo(value: unknown): TodoActivity | undefined {
  const fields = asObject(value)
  if (!fields) {
    return undefined
  }
  const id = requiredText(fields.id, idTextLimit)
  const content = requiredText(fields.content, todoTextLimit)
  if (!id || !content) {
    return undefined
  }
  const rawStatus = fields.status ?? 'pending'
  if (!isTodoStatus(rawStatus)) {
    return undefined
  }
  return { id, content, status: rawStatus }
}

function parseTodos(value: unknown): TodoActivity[] | undefined {
  if (!Array.isArray(value) || value.length > todoLimit) {
    return undefined
  }
  const todos = value.map(parseTodo)
  return todos.every((todo): todo is TodoActivity => todo !== undefined) ? todos : undefined
}

function parseTodoToolResult(frame: Record<string, unknown>): TodoActivity[] | undefined {
  if (frame.toolName !== 'todo') {
    return undefined
  }
  const result = asObject(frame.result)
  if (!result || result.isError !== false || typeof result.content !== 'string') {
    return undefined
  }
  try {
    const payload = asObject(JSON.parse(result.content))
    return parseTodos(payload?.todos)
  } catch {
    return undefined
  }
}

export function normalizeActivityFrame(frameValue: unknown): ActivityAction | undefined {
  const frame = asObject(frameValue)
  if (!frame || typeof frame.type !== 'string') {
    return undefined
  }

  switch (frame.type) {
    case 'agent_start': {
      const runId = optionalRunId(frame.runId)
      return runId === null ? undefined : { type: 'run-started', runId }
    }
    case 'agent_end': {
      const runId = optionalRunId(frame.runId)
      return runId === null ? undefined : { type: 'run-ended', runId }
    }
    case 'message_start': {
      const message = asObject(frame.message)
      const advisor = message?.role === 'user' ? parseAdvisor(message.content) : undefined
      const runId = optionalRunId(frame.runId)
      return advisor && runId !== null ? { type: 'advisor', advisor, runId } : undefined
    }
    case 'subagent_start': {
      const goal = requiredText(frame.goal, goalTextLimit)
      const index = nonNegativeInteger(frame.index)
      const count = positiveInteger(frame.count)
      if (
        !goal ||
        index === undefined ||
        count === undefined ||
        count > subagentLimit ||
        index >= count
      ) {
        return undefined
      }
      return { type: 'subagent-started', goal, index, count }
    }
    case 'subagent_update': {
      const index = nonNegativeInteger(frame.index)
      const delta = boundedText(frame.delta, responseTextLimit)
      return index === undefined || !delta ? undefined : { type: 'subagent-updated', index, delta }
    }
    case 'subagent_end': {
      const goal = requiredText(frame.goal, goalTextLimit)
      const index = nonNegativeInteger(frame.index)
      const result = boundedText(frame.result, responseTextLimit)
      if (!goal || index === undefined || result === undefined) {
        return undefined
      }
      return {
        type: 'subagent-ended',
        goal,
        index,
        result,
        status: result === 'Error: [stopped by user]' ? 'interrupted' : 'completed'
      }
    }
    case 'tool_execution_end': {
      const todos = parseTodoToolResult(frame)
      return todos ? { type: 'todos', todos } : undefined
    }
    default:
      return undefined
  }
}

export function normalizeActivityState(value: unknown): ActivityAction | undefined {
  const fields = asObject(value)
  if (!fields) {
    return undefined
  }
  const todos = parseTodos(fields.todos)
  return todos ? { type: 'todos', todos } : undefined
}

function assistantContent(subagent: SubagentActivity): string {
  return subagent.messages.find((message) => message.role === 'assistant')?.content ?? ''
}

function subagentWithResponse(
  subagent: SubagentActivity,
  goal: string,
  response: string,
  status: SubagentActivity['status']
): SubagentActivity {
  return {
    ...subagent,
    goal,
    status,
    messages: [
      { role: 'user', content: goal },
      { role: 'assistant', content: response }
    ]
  }
}

export function reduceActivitySnapshot(
  state: ActivitySnapshot,
  action: ActivityAction
): ActivitySnapshot {
  switch (action.type) {
    case 'run-started':
      return {
        ...state,
        running: true,
        advisor: null,
        subagentCount: 0,
        subagents: []
      }
    case 'run-ended':
      return {
        ...state,
        running: false,
        subagents: state.subagents.map((subagent) =>
          subagent.status === 'running' ? { ...subagent, status: 'interrupted' } : subagent
        )
      }
    case 'advisor':
      return { ...state, advisor: action.advisor }
    case 'subagent-started': {
      const next = state.subagents.filter((subagent) => subagent.index !== action.index)
      next.push({
        index: action.index,
        goal: action.goal,
        status: 'running',
        messages: [
          { role: 'user', content: action.goal },
          { role: 'assistant', content: '' }
        ]
      })
      next.sort((left, right) => left.index - right.index)
      return {
        ...state,
        subagentCount: Math.max(state.subagentCount, action.count),
        subagents: next
      }
    }
    case 'subagent-updated': {
      const target = state.subagents.find(
        (subagent) => subagent.index === action.index && subagent.status === 'running'
      )
      if (!target) {
        return state
      }
      const currentResponse = assistantContent(target)
      const response = bounded(`${currentResponse}${action.delta}`, responseTextLimit)
      if (response === currentResponse) {
        return state
      }
      return {
        ...state,
        subagents: state.subagents.map((subagent) =>
          subagent === target
            ? subagentWithResponse(subagent, subagent.goal, response, subagent.status)
            : subagent
        )
      }
    }
    case 'subagent-ended': {
      const target = state.subagents.find(
        (subagent) => subagent.index === action.index && subagent.status === 'running'
      )
      if (!target) {
        return state
      }
      return {
        ...state,
        subagents: state.subagents.map((subagent) =>
          subagent === target
            ? subagentWithResponse(subagent, action.goal, action.result, action.status)
            : subagent
        )
      }
    }
    case 'todos':
      return { ...state, todos: action.todos }
  }
}

function copySnapshot(snapshot: ActivitySnapshot): ActivitySnapshot {
  return {
    ...snapshot,
    advisor: snapshot.advisor ? { ...snapshot.advisor } : null,
    subagents: snapshot.subagents.map((subagent) => ({
      ...subagent,
      messages: subagent.messages.map((message) => ({ ...message }))
    })),
    todos: snapshot.todos.map((todo) => ({ ...todo }))
  }
}

export class ActivityService {
  private readonly backend: ActivityBackend
  private readonly listeners = new Set<(update: ActivityUpdate) => void>()
  private readonly streamBroadcastIntervalMilliseconds: number
  private readonly unsubscribeFrames: () => void
  private broadcastTimer: ReturnType<typeof setTimeout> | undefined
  private currentRunId: string | undefined
  private hydration: Promise<void> | undefined
  private snapshot = emptyActivitySnapshot()

  constructor(backend: ActivityBackend, options: ActivityServiceOptions = {}) {
    this.backend = backend
    this.streamBroadcastIntervalMilliseconds =
      options.streamBroadcastIntervalMilliseconds ?? defaultStreamBroadcastIntervalMilliseconds
    this.unsubscribeFrames = backend.subscribeFrames((frame) => this.consume(frame))
  }

  getSnapshot(): ActivitySnapshot {
    return copySnapshot(this.snapshot)
  }

  hydrate(): Promise<void> {
    this.hydration ??= this.refresh()
    return this.hydration
  }

  async refresh(): Promise<void> {
    const data = await this.backend.request('get_state')
    const action = normalizeActivityState(data)
    if (!action) {
      throw new Error('The backend returned invalid activity state')
    }
    this.commit(action)
  }

  subscribe(listener: (update: ActivityUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.cancelPendingBroadcast()
    this.unsubscribeFrames()
    this.listeners.clear()
  }

  private consume(frame: Record<string, unknown>): void {
    const action = normalizeActivityFrame(frame)
    if (!action) {
      return
    }
    if (action.type === 'run-started') {
      this.currentRunId = action.runId
    } else if (
      (action.type === 'advisor' || action.type === 'run-ended') &&
      action.runId !== this.currentRunId
    ) {
      return
    }
    this.commit(action, action.type === 'subagent-updated')
  }

  private commit(action: ActivityAction, coalesceBroadcast = false): void {
    const next = reduceActivitySnapshot(this.snapshot, action)
    if (next === this.snapshot) {
      return
    }
    this.snapshot = { ...next, revision: this.snapshot.revision + 1 }
    if (coalesceBroadcast) {
      this.scheduleBroadcast()
      return
    }
    this.cancelPendingBroadcast()
    this.publishSnapshot()
  }

  private scheduleBroadcast(): void {
    this.broadcastTimer ??= setTimeout(() => {
      this.broadcastTimer = undefined
      this.publishSnapshot()
    }, this.streamBroadcastIntervalMilliseconds)
  }

  private cancelPendingBroadcast(): void {
    if (this.broadcastTimer !== undefined) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = undefined
    }
  }

  private publishSnapshot(): void {
    const snapshot = copySnapshot(this.snapshot)
    const update = { revision: snapshot.revision, snapshot }
    for (const listener of this.listeners) {
      listener(update)
    }
  }
}
