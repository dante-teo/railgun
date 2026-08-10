import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activitySnapshotChannel,
  activityUpdateChannel,
  emptyActivitySnapshot,
  type ActivityUpdate
} from '../shared/activity-api.ts'
import { createActivityApi, type ActivityIpcRenderer } from './activity-api.mts'

interface StubIpcRenderer extends ActivityIpcRenderer {
  readonly listeners: Map<string, Set<(event: unknown, update: ActivityUpdate) => void>>
  readonly emit: (update: ActivityUpdate) => void
}

function stubIpcRenderer(): StubIpcRenderer {
  const listeners = new Map<string, Set<(event: unknown, update: ActivityUpdate) => void>>()
  const snapshot = emptyActivitySnapshot()
  return {
    listeners,
    invoke: async (channel) => {
      assert.equal(channel, activitySnapshotChannel)
      return snapshot
    },
    on: (channel, listener) => {
      const channelListeners = listeners.get(channel) ?? new Set()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    },
    removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
    emit: (update) =>
      listeners.get(activityUpdateChannel)?.forEach((listener) => listener(undefined, update))
  }
}

test('activity preload invokes snapshots, forwards updates, and removes subscriptions', async () => {
  const ipc = stubIpcRenderer()
  const api = createActivityApi(ipc)
  const received: ActivityUpdate[] = []
  const unsubscribe = api.subscribe((update) => received.push(update))
  const update = {
    revision: 1,
    snapshot: { ...emptyActivitySnapshot(), revision: 1 }
  }

  assert.deepEqual(await api.getSnapshot(), emptyActivitySnapshot())
  ipc.emit(update)
  unsubscribe()
  ipc.emit({ revision: 2, snapshot: { ...emptyActivitySnapshot(), revision: 2 } })

  assert.deepEqual(received, [update])
  assert.equal(ipc.listeners.get(activityUpdateChannel)?.size, 0)
})
