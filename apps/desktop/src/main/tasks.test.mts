import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TaskService,
  validateSessionId,
  type BackendRequester,
  type BackendRequestOptions
} from './tasks.mts'

interface StubBackend extends BackendRequester {
  readonly calls: Array<{
    command: string
    fields?: Record<string, unknown>
    options?: BackendRequestOptions
  }>
}

function stubBackend(response: unknown, failure?: Error): StubBackend {
  const calls: StubBackend['calls'] = []
  return {
    calls,
    request: async (command, fields, options) => {
      calls.push({ command, fields, options })
      if (failure) {
        throw failure
      }
      return response
    }
  }
}

test('TaskService validates and narrows task summaries without changing backend order', async (): Promise<void> => {
  const backend = stubBackend({
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
    await assert.rejects(new TaskService(stubBackend(response)).list(), /invalid/i)
  }
})

test('TaskService validates renderer session IDs before archiving', async (): Promise<void> => {
  const backend = stubBackend(undefined)
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
  const backend = stubBackend({ sessionId: 'task-123' })
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
    await assert.rejects(new TaskService(stubBackend(response)).open('task-123'), /invalid/i)
  }
})

test('TaskService preserves archive failures for the IPC caller', async (): Promise<void> => {
  const service = new TaskService(
    stubBackend(undefined, new Error('active session task-123 not found'))
  )

  await assert.rejects(service.archive('task-123'), /active session task-123 not found/)
})

test('TaskService validates archived summaries and deletion acknowledgements', async () => {
  const responses = [
    {
      sessions: [
        {
          id: 'archived',
          firstUserPreview: 'Archived task',
          lastMessageAt: '2026-08-09T02:00:00.000Z',
          archivedAt: '2026-08-10T02:00:00.000Z',
          model: 'gpt-5',
          messageCount: 4
        }
      ]
    },
    { deletedSessionId: 'archived' },
    { deletedCount: 3 }
  ]
  const calls: StubBackend['calls'] = []
  const backend: StubBackend = {
    calls,
    request: async (command, fields, options) => {
      calls.push({ command, fields, options })
      return responses.shift()
    }
  }
  const service = new TaskService(backend)
  assert.equal((await service.listArchived())[0].messageCount, 4)
  await service.deleteArchived('archived')
  assert.equal(await service.deleteAllArchived(), 3)
})
