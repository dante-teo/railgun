import assert from 'node:assert/strict'
import test from 'node:test'

import type { ActivityUpdate } from '../shared/activity-api.ts'
import {
  ActivityService,
  normalizeActivityFrame,
  normalizeActivityState,
  type ActivityBackend
} from './activity.mts'

class StubActivityBackend implements ActivityBackend {
  readonly listeners = new Set<(frame: Record<string, unknown>) => void>()
  response: unknown = { todos: [] }
  requests: string[] = []

  async request(command: string): Promise<unknown> {
    this.requests.push(command)
    return this.response
  }

  subscribeFrames(listener: (frame: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(frame: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(frame)
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

test('activity normalization rejects malformed frames and bounds presentation text', () => {
  for (const frame of [
    null,
    [],
    {},
    { type: 'agent_start', runId: ' ' },
    { type: 'subagent_start', goal: '', index: 0, count: 1 },
    { type: 'subagent_start', goal: 'Inspect', index: 1, count: 1 },
    { type: 'subagent_update', index: -1, delta: 'nope' },
    {
      type: 'message_start',
      message: { role: 'user', content: '<advisory severity="unknown">Nope</advisory>' }
    },
    {
      type: 'tool_execution_end',
      toolName: 'todo',
      result: { isError: false, content: '{"todos":[{"id":7}]}' }
    }
  ]) {
    assert.equal(normalizeActivityFrame(frame), undefined)
  }

  const advisor = normalizeActivityFrame({
    type: 'message_start',
    message: {
      role: 'user',
      content: `<advisory severity="concern">${'x'.repeat(2_100)} &amp; safe</advisory>`
    }
  })
  assert.equal(advisor?.type, 'advisor')
  if (advisor?.type !== 'advisor') {
    throw new Error('Expected an advisor action')
  }
  assert.equal(advisor.advisor.text.length, 2_000)
  assert.match(advisor.advisor.text, /…$/)

  const delta = normalizeActivityFrame({
    type: 'subagent_update',
    index: 0,
    delta: 'x'.repeat(21_000)
  })
  assert.equal(delta?.type, 'subagent-updated')
  if (delta?.type !== 'subagent-updated') {
    throw new Error('Expected a subagent update action')
  }
  assert.equal(delta.delta.length, 20_000)
})

test('activity state hydration validates TODO snapshots and defaults missing status to pending', () => {
  assert.deepEqual(
    normalizeActivityState({
      todos: [
        { id: 'inspect', content: 'Inspect activity', status: 'in_progress' },
        { id: 'verify', content: 'Verify activity' }
      ]
    }),
    {
      type: 'todos',
      todos: [
        { id: 'inspect', content: 'Inspect activity', status: 'in_progress' },
        { id: 'verify', content: 'Verify activity', status: 'pending' }
      ]
    }
  )
  assert.equal(
    normalizeActivityState({ todos: [{ id: 'x', content: 'X', status: 'done' }] }),
    undefined
  )
  assert.equal(normalizeActivityState({}), undefined)
})

test('ActivityService hydrates TODOs, streams subagents, resets runs, and orders revisions', async () => {
  const backend = new StubActivityBackend()
  backend.response = {
    todos: [
      { id: 'one', content: 'One', status: 'completed' },
      { id: 'two', content: 'Two', status: 'in_progress' }
    ]
  }
  const service = new ActivityService(backend)
  const updates: ActivityUpdate[] = []
  const unsubscribe = service.subscribe((update) => updates.push(update))

  await service.hydrate()
  backend.emit({ type: 'agent_start', runId: 'run-one' })
  backend.emit({
    type: 'message_start',
    runId: 'run-one',
    message: {
      role: 'user',
      content: '<advisory severity="nit">Keep the boundary small.</advisory>'
    }
  })
  backend.emit({ type: 'subagent_start', goal: 'Inspect', index: 0, count: 2 })
  backend.emit({ type: 'subagent_update', index: 0, delta: 'Streamed draft' })
  backend.emit({ type: 'subagent_start', goal: 'Verify', index: 1, count: 2 })
  backend.emit({ type: 'subagent_end', goal: 'Inspect', index: 0, result: 'Final result' })
  backend.emit({
    type: 'subagent_end',
    goal: 'Verify',
    index: 1,
    result: 'Error: [stopped by user]'
  })
  backend.emit({ type: 'subagent_start', goal: 'Document', index: 2, count: 3 })
  backend.emit({
    type: 'tool_execution_end',
    toolName: 'todo',
    result: {
      isError: false,
      content: JSON.stringify({
        todos: [
          { id: 'one', content: 'One', status: 'completed' },
          { id: 'two', content: 'Two', status: 'completed' }
        ]
      })
    }
  })
  backend.emit({ type: 'agent_end', runId: 'run-one' })

  const settled = service.getSnapshot()
  assert.deepEqual(backend.requests, ['get_state'])
  assert.equal(settled.advisor?.text, 'Keep the boundary small.')
  assert.equal(settled.subagentCount, 3)
  assert.deepEqual(
    settled.subagents.map((subagent) => ({
      goal: subagent.goal,
      status: subagent.status,
      response: subagent.messages[1].content
    })),
    [
      { goal: 'Inspect', status: 'completed', response: 'Final result' },
      { goal: 'Verify', status: 'interrupted', response: 'Error: [stopped by user]' },
      { goal: 'Document', status: 'interrupted', response: '' }
    ]
  )
  assert.deepEqual(
    settled.todos.map((todo) => todo.status),
    ['completed', 'completed']
  )
  assert.ok(
    updates.every((update, index) => index === 0 || update.revision > updates[index - 1].revision)
  )
  assert.ok(updates.every((update) => update.revision === update.snapshot.revision))

  backend.emit({ type: 'agent_start', runId: 'run-two' })
  const nextRun = service.getSnapshot()
  assert.equal(nextRun.advisor, null)
  assert.equal(nextRun.subagentCount, 0)
  assert.deepEqual(nextRun.subagents, [])
  assert.equal(nextRun.todos.length, 2)

  unsubscribe()
  service.dispose()
  assert.equal(backend.listeners.size, 0)
})

test('ActivityService ignores advisor and end frames from an older tagged run', () => {
  const backend = new StubActivityBackend()
  const service = new ActivityService(backend)

  backend.emit({ type: 'agent_start', runId: 'run-one' })
  backend.emit({
    type: 'message_start',
    runId: 'run-one',
    message: {
      role: 'user',
      content: '<advisory severity="nit">First run advice.</advisory>'
    }
  })
  backend.emit({ type: 'agent_start', runId: 'run-two' })
  backend.emit({
    type: 'message_start',
    runId: 'run-one',
    message: {
      role: 'user',
      content: '<advisory severity="blocker">Stale advice.</advisory>'
    }
  })
  backend.emit({ type: 'subagent_start', goal: 'Current work', index: 0, count: 1 })
  backend.emit({ type: 'agent_end', runId: 'run-one' })

  assert.equal(service.getSnapshot().advisor, null)
  assert.equal(service.getSnapshot().running, true)
  assert.equal(service.getSnapshot().subagents[0].status, 'running')

  backend.emit({
    type: 'message_start',
    runId: 'run-two',
    message: {
      role: 'user',
      content: '<advisory severity="concern">Current advice.</advisory>'
    }
  })
  assert.equal(service.getSnapshot().advisor?.text, 'Current advice.')
  service.dispose()
})

test('ActivityService coalesces streamed deltas and publishes final results immediately', async () => {
  const backend = new StubActivityBackend()
  const service = new ActivityService(backend, { streamBroadcastIntervalMilliseconds: 10 })
  const updates: ActivityUpdate[] = []
  service.subscribe((update) => updates.push(update))

  backend.emit({ type: 'agent_start', runId: 'run-one' })
  backend.emit({ type: 'subagent_start', goal: 'Stream', index: 0, count: 1 })
  updates.length = 0
  backend.emit({ type: 'subagent_update', index: 0, delta: 'One ' })
  backend.emit({ type: 'subagent_update', index: 0, delta: 'two ' })
  backend.emit({ type: 'subagent_update', index: 0, delta: 'three' })

  assert.equal(updates.length, 0)
  assert.equal(service.getSnapshot().subagents[0].messages[1].content, 'One two three')
  await delay(20)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].snapshot.subagents[0].messages[1].content, 'One two three')

  updates.length = 0
  backend.emit({ type: 'subagent_update', index: 0, delta: ' stale draft' })
  backend.emit({ type: 'subagent_end', goal: 'Stream', index: 0, result: 'Final result' })
  assert.equal(updates.length, 1)
  assert.equal(updates[0].snapshot.subagents[0].messages[1].content, 'Final result')
  await delay(20)
  assert.equal(updates.length, 1)
  service.dispose()
})

test('ActivityService rejects malformed initial TODO hydration', async () => {
  const backend = new StubActivityBackend()
  backend.response = { todos: [{ id: 'x', content: 'X', status: 'unknown' }] }
  const service = new ActivityService(backend)

  await assert.rejects(service.hydrate(), /invalid activity state/)
  assert.equal(service.getSnapshot().revision, 0)
  service.dispose()
})

test('ActivityService refreshes TODO state after the active task changes', async () => {
  const backend = new StubActivityBackend()
  const service = new ActivityService(backend)

  await service.hydrate()
  backend.response = {
    todos: [{ id: 'selected', content: 'Inspect selected task', status: 'in_progress' }]
  }
  await service.refresh()

  assert.deepEqual(backend.requests, ['get_state', 'get_state'])
  assert.deepEqual(service.getSnapshot().todos, [
    { id: 'selected', content: 'Inspect selected task', status: 'in_progress' }
  ])
  service.dispose()
})
