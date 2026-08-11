import type { ArchivedTaskSummary, TaskSummary } from '../shared/task-api.ts'
import { asObject, nonNegativeInteger } from './value-validation.mts'

const untitledTask = 'Untitled Task'
const maximumSessionIdLength = 512
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/

export interface BackendRequester {
  request(
    command: string,
    fields?: Record<string, unknown>,
    options?: BackendRequestOptions
  ): Promise<unknown>
}

export interface BackendRequestOptions {
  timeout?: 'default' | 'none'
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

export function validateSessionId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximumSessionIdLength ||
    containsControlCharacter(value)
  ) {
    throw new Error('Invalid task identifier')
  }
  return value
}

function validateTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isoTimestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error('The backend returned an invalid task timestamp')
  }
  return value
}

function parseTaskSummary(value: unknown): TaskSummary {
  const fields = asObject(value)
  if (!fields || typeof fields.firstUserPreview !== 'string') {
    throw new Error('The backend returned an invalid task summary')
  }
  const title = fields.firstUserPreview.trim()
  return {
    id: validateSessionId(fields.id),
    title: title || untitledTask,
    lastMessageAt: validateTimestamp(fields.lastMessageAt)
  }
}

function parseArchivedTaskSummary(value: unknown): ArchivedTaskSummary {
  const fields = asObject(value)
  const base = parseTaskSummary(value)
  const messageCount = nonNegativeInteger(fields?.messageCount)
  if (!fields || typeof fields.model !== 'string' || !fields.model || messageCount === undefined) {
    throw new Error('The backend returned an invalid archived task summary')
  }
  return {
    id: base.id,
    title: base.title,
    model: fields.model,
    messageCount,
    archivedAt: validateTimestamp(fields.archivedAt)
  }
}

export class TaskService {
  private readonly backend: BackendRequester

  constructor(backend: BackendRequester) {
    this.backend = backend
  }

  async list(): Promise<TaskSummary[]> {
    const data = asObject(await this.backend.request('session_list'))
    if (!data || !Array.isArray(data.sessions)) {
      throw new Error('The backend returned an invalid task list')
    }
    return data.sessions.map(parseTaskSummary)
  }

  async archive(sessionId: unknown): Promise<void> {
    await this.backend.request(
      'session_archive',
      { sessionId: validateSessionId(sessionId) },
      { timeout: 'none' }
    )
  }

  async listArchived(): Promise<ArchivedTaskSummary[]> {
    const data = asObject(await this.backend.request('session_list_archived'))
    if (!data || !Array.isArray(data.sessions)) {
      throw new Error('The backend returned an invalid archived task list')
    }
    return data.sessions.map(parseArchivedTaskSummary)
  }

  async unarchive(sessionId: unknown): Promise<void> {
    await this.backend.request(
      'session_unarchive',
      { sessionId: validateSessionId(sessionId) },
      { timeout: 'none' }
    )
  }

  async deleteArchived(sessionId: unknown): Promise<void> {
    const validatedSessionId = validateSessionId(sessionId)
    const response = asObject(
      await this.backend.request(
        'session_delete_archived',
        { sessionId: validatedSessionId },
        { timeout: 'none' }
      )
    )
    if (response?.deletedSessionId !== validatedSessionId) {
      throw new Error('The backend returned an invalid archived task deletion')
    }
  }

  async deleteAllArchived(): Promise<number> {
    const response = asObject(
      await this.backend.request('session_delete_all_archived', {}, { timeout: 'none' })
    )
    const deletedCount = nonNegativeInteger(response?.deletedCount)
    if (deletedCount === undefined) {
      throw new Error('The backend returned an invalid archived task deletion count')
    }
    return deletedCount
  }

  async open(sessionId: unknown): Promise<void> {
    const validatedSessionId = validateSessionId(sessionId)
    const data = asObject(
      await this.backend.request('session_load', {
        sessionId: validatedSessionId,
        includeMessages: false
      })
    )
    if (data?.sessionId !== validatedSessionId) {
      throw new Error('The backend returned an invalid loaded task')
    }
  }
}
