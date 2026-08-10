import assert from 'node:assert/strict'
import test from 'node:test'

import {
  contextUsageSnapshotChannel,
  contextUsageUpdateChannel,
  emptyContextUsageSnapshot,
  type ContextUsageUpdate
} from '../shared/context-usage-api.ts'
import { createContextUsageApi, type ContextUsageIpcRenderer } from './context-usage-api.mts'

interface StubIpcRenderer extends ContextUsageIpcRenderer {
  readonly listeners: Map<string, Set<(event: unknown, update: ContextUsageUpdate) => void>>
  readonly emit: (update: ContextUsageUpdate) => void
}

function stubIpcRenderer(): StubIpcRenderer {
  const listeners = new Map<string, Set<(event: unknown, update: ContextUsageUpdate) => void>>()
  const snapshot = emptyContextUsageSnapshot()
  return {
    listeners,
    invoke: async (channel) => {
      assert.equal(channel, contextUsageSnapshotChannel)
      return snapshot
    },
    on: (channel, listener) => {
      const channelListeners = listeners.get(channel) ?? new Set()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    },
    removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
    emit: (update) =>
      listeners.get(contextUsageUpdateChannel)?.forEach((listener) => listener(undefined, update))
  }
}

test('context usage preload invokes snapshots, forwards updates, and removes subscriptions', async () => {
  const ipc = stubIpcRenderer()
  const api = createContextUsageApi(ipc)
  const received: ContextUsageUpdate[] = []
  const unsubscribe = api.subscribe((update) => received.push(update))
  const update = {
    revision: 1,
    snapshot: { revision: 1, contextWindow: 200_000, usedTokens: 150_000 }
  }

  assert.deepEqual(await api.getSnapshot(), emptyContextUsageSnapshot())
  ipc.emit(update)
  unsubscribe()
  ipc.emit({
    revision: 2,
    snapshot: { revision: 2, contextWindow: 200_000, usedTokens: 160_000 }
  })

  assert.deepEqual(received, [update])
  assert.equal(ipc.listeners.get(contextUsageUpdateChannel)?.size, 0)
})
