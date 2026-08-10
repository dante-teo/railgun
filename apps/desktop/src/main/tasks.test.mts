import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TaskService,
  validateSessionId,
  type BackendRequester,
  type BackendRequestOptions
} from './tasks.mts'

class StubBackend implements BackendRequester {
  readonly calls: Array<{
    command: string
    fields?: Record<string, unknown>
    options?: BackendRequestOptions
  }> = []
  private readonly failure: Error | undefined
  private readonly response: unknown

  constructor(response: unknown, failure?: Error) {
    this.response = response
    this.failure = failure
  }

  async request(
    command: string,
    fields?: Record<string, unknown>,
    options?: BackendRequestOptions
  ): Promise<unknown> {
    this.calls.push({ command, fields, options })
    if (this.failure) {
      throw this.failure
    }
    return this.response
  }
}

test('TaskService validates and narrows task summaries without changing backend order', async (): Promise<void> => {
  const backend = new StubBackend({
    sessions: [
      {
        id: 'first',
        firstUserPreview: '  First task  ',
        lastMessageAt: '2026-08-09T02:00:00.000Z',
        privateField: 'not exposed'
      },
      {
        id: 'second',
        firstUserPreview: '   ',
        lastMessageAt: '2026-08-08T02:00:00+00:00'
      }
    ]
  })

  assert.deepEqual(await new TaskService(backend).list(), [
    {
      id: 'first',
      title: 'First task',
      lastMessageAt: '2026-08-09T02:00:00.000Z'
    },
    {
      id: 'second',
      title: 'Untitled Task',
      lastMessageAt: '2026-08-08T02:00:00+00:00'
    }
  ])
  assert.deepEqual(backend.calls, [
    { command: 'session_list', fields: undefined, options: undefined }
  ])
})

test('TaskService rejects malformed list responses', async (): Promise<void> => {
  for (const response of [
    undefined,
    { sessions: null },
    { sessions: [{ id: 'task', firstUserPreview: 'Task', lastMessageAt: 'not-a-date' }] },
    { sessions: [{ id: '', firstUserPreview: 'Task', lastMessageAt: '2026-08-09T02:00:00Z' }] }
  ]) {
    await assert.rejects(new TaskService(new StubBackend(response)).list(), /invalid/i)
  }
})

test('TaskService validates renderer session IDs before archiving', async (): Promise<void> => {
  const backend = new StubBackend(undefined)
  const service = new TaskService(backend)

  await service.archive('task-123')
  assert.deepEqual(backend.calls, [
    {
      command: 'session_archive',
      fields: { sessionId: 'task-123' },
      options: { timeout: 'none' }
    }
  ])
  await assert.rejects(service.archive('  '), /Invalid task identifier/)
  await assert.rejects(service.archive(' task-123'), /Invalid task identifier/)
  assert.equal(backend.calls.length, 1)
  assert.throws(() => validateSessionId('task\n123'), /Invalid task identifier/)
})

test('TaskService opens a validated task without crossing transcript content into the renderer', async (): Promise<void> => {
  const backend = new StubBackend({ sessionId: 'task-123' })
  const service = new TaskService(backend)

  await service.open('task-123')
  assert.deepEqual(backend.calls, [
    {
      command: 'session_load',
      fields: { sessionId: 'task-123', includeMessages: false },
      options: undefined
    }
  ])
  await assert.rejects(service.open(' task-123'), /Invalid task identifier/)
  assert.equal(backend.calls.length, 1)
})

test('TaskService rejects malformed or mismatched loaded task responses', async (): Promise<void> => {
  for (const response of [undefined, {}, { sessionId: 'another-task' }]) {
    await assert.rejects(new TaskService(new StubBackend(response)).open('task-123'), /invalid/i)
  }
})

test('TaskService preserves archive failures for the IPC caller', async (): Promise<void> => {
  const service = new TaskService(
    new StubBackend(undefined, new Error('active session task-123 not found'))
  )

  await assert.rejects(service.archive('task-123'), /active session task-123 not found/)
})
