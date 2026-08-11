import assert from 'node:assert/strict'
import test from 'node:test'

import { createActiveSessionMutationQueue } from './active-session-mutations.mts'

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly reject: (reason?: unknown) => void
  readonly resolve: (value: Value) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

test('active-session mutations run serially in invocation order', async () => {
  const queue = createActiveSessionMutationQueue()
  const firstMutation = deferred<void>()
  const events: string[] = []

  const first = queue.run(async () => {
    events.push('model:start')
    await firstMutation.promise
    events.push('model:end')
    return 'model-result'
  })
  const second = queue.run(async () => {
    events.push('create:start')
    return 'create-result'
  })

  await Promise.resolve()
  assert.deepEqual(events, ['model:start'])

  firstMutation.resolve()
  assert.deepEqual(await Promise.all([first, second]), ['model-result', 'create-result'])
  assert.deepEqual(events, ['model:start', 'model:end', 'create:start'])
})

test('a failed active-session mutation does not block the queue', async () => {
  const queue = createActiveSessionMutationQueue()

  await assert.rejects(
    queue.run(async () => {
      throw new Error('model failed')
    }),
    /model failed/
  )
  assert.equal(await queue.run(async () => 'create-result'), 'create-result')
})
