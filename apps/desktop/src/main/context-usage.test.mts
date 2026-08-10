import assert from 'node:assert/strict'
import test from 'node:test'

import type { ContextUsageUpdate } from '../shared/context-usage-api.ts'
import {
  ContextUsageService,
  normalizeContextConfiguration,
  normalizeContextUsageFrame,
  type ContextUsageBackend
} from './context-usage.mts'

interface StubContextUsageBackend extends ContextUsageBackend {
  readonly listeners: Set<(frame: Record<string, unknown>) => void>
  readonly requests: string[]
  state: unknown
  models: unknown
  emit: (frame: Record<string, unknown>) => void
}

function stubContextUsageBackend(): StubContextUsageBackend {
  const listeners = new Set<(frame: Record<string, unknown>) => void>()
  const requests: string[] = []
  const backend: StubContextUsageBackend = {
    listeners,
    requests,
    state: { model: 'gpt-5' },
    models: { models: [{ id: 'gpt-5', contextWindow: 200_000 }] },
    request: async (command) => {
      requests.push(command)
      return command === 'get_state' ? backend.state : backend.models
    },
    subscribeFrames: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (frame) => listeners.forEach((listener) => listener(frame))
  }
  return backend
}

test('context usage normalization accepts provider usage frames and rejects malformed totals', () => {
  assert.deepEqual(
    normalizeContextUsageFrame({
      type: 'message_update',
      streamEvent: { type: 'usage', inputTokens: 120_000, outputTokens: 30_000 }
    }),
    { type: 'usage', usedTokens: 150_000 }
  )
  assert.deepEqual(
    normalizeContextUsageFrame({
      type: 'turn_end',
      usage: { inputTokens: 1_200, outputTokens: 300 }
    }),
    { type: 'usage', usedTokens: 1_500 }
  )

  for (const frame of [
    null,
    {},
    { type: 'turn_end', usage: null },
    { type: 'turn_end', usage: { inputTokens: -1, outputTokens: 2 } },
    { type: 'turn_end', usage: { inputTokens: 1.5, outputTokens: 2 } },
    {
      type: 'turn_end',
      usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }
    },
    { type: 'message_update', streamEvent: { type: 'text_delta', delta: 'hello' } }
  ]) {
    assert.equal(normalizeContextUsageFrame(frame), undefined)
  }
})

test('context configuration resolves the active model context window', () => {
  assert.deepEqual(
    normalizeContextConfiguration(
      {
        model: 'gpt-5',
        latestUsage: { inputTokens: 120_000, outputTokens: 30_000 }
      },
      {
        models: [
          { id: 'other', contextWindow: 128_000 },
          { id: 'gpt-5', contextWindow: 200_000 }
        ]
      }
    ),
    { type: 'configuration', contextWindow: 200_000, usedTokens: 150_000 }
  )

  assert.equal(normalizeContextConfiguration({}, { models: [] }), undefined)
  assert.equal(
    normalizeContextConfiguration(
      { model: 'missing' },
      { models: [{ id: 'gpt-5', contextWindow: 200_000 }] }
    ),
    undefined
  )
  assert.equal(
    normalizeContextConfiguration(
      { model: 'gpt-5' },
      { models: [{ id: 'gpt-5', contextWindow: 0 }] }
    ),
    undefined
  )
  assert.equal(
    normalizeContextConfiguration(
      { model: 'gpt-5', latestUsage: { inputTokens: -1, outputTokens: 2 } },
      { models: [{ id: 'gpt-5', contextWindow: 200_000 }] }
    ),
    undefined
  )
})

test('ContextUsageService restores the selected session latest usage', async () => {
  const backend = stubContextUsageBackend()
  backend.state = {
    model: 'gpt-5',
    latestUsage: { inputTokens: 120_000, outputTokens: 30_000 }
  }
  const service = new ContextUsageService(backend)

  await service.hydrate()

  assert.deepEqual(service.getSnapshot(), {
    revision: 1,
    contextWindow: 200_000,
    usedTokens: 150_000
  })
  service.dispose()
})

test('ContextUsageService hydrates the model window, streams usage, and resets on refresh', async () => {
  const backend = stubContextUsageBackend()
  const service = new ContextUsageService(backend)
  const updates: ContextUsageUpdate[] = []
  service.subscribe((update) => updates.push(update))

  await service.hydrate()
  assert.deepEqual(backend.requests, ['get_state', 'get_available_models'])
  assert.deepEqual(service.getSnapshot(), {
    revision: 1,
    contextWindow: 200_000,
    usedTokens: null
  })

  backend.emit({
    type: 'message_update',
    streamEvent: { type: 'usage', inputTokens: 120_000, outputTokens: 30_000 }
  })
  backend.emit({
    type: 'turn_end',
    usage: { inputTokens: 120_000, outputTokens: 30_000 }
  })
  assert.deepEqual(service.getSnapshot(), {
    revision: 2,
    contextWindow: 200_000,
    usedTokens: 150_000
  })
  assert.equal(updates.length, 2)

  backend.state = { model: 'compact' }
  backend.models = { models: [{ id: 'compact', contextWindow: 128_000 }] }
  await service.refresh()
  assert.deepEqual(service.getSnapshot(), {
    revision: 3,
    contextWindow: 128_000,
    usedTokens: null
  })

  service.dispose()
  assert.equal(backend.listeners.size, 0)
})

test('ContextUsageService rejects malformed hydration without replacing current state', async () => {
  const backend = stubContextUsageBackend()
  const service = new ContextUsageService(backend)
  await service.hydrate()

  backend.models = { models: [] }
  await assert.rejects(service.refresh(), /invalid context configuration/)
  assert.deepEqual(service.getSnapshot(), {
    revision: 1,
    contextWindow: 200_000,
    usedTokens: null
  })
  service.dispose()
})
