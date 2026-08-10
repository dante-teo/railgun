import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activitySnapshotChannel,
  activityUpdateChannel,
  emptyActivitySnapshot,
  type ActivityUpdate
} from '../shared/activity-api.ts'
import { createActivityApi, type ActivityIpcRenderer } from './activity-api.mts'

class StubIpcRenderer implements ActivityIpcRenderer {
  readonly listeners = new Map<string, Set<(event: unknown, update: ActivityUpdate) => void>>()
  readonly snapshot = emptyActivitySnapshot()

  async invoke(channel: string): Promise<unknown> {
    assert.equal(channel, activitySnapshotChannel)
    return this.snapshot
  }

  on(channel: string, listener: (event: unknown, update: ActivityUpdate) => void): void {
    const listeners = this.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.listeners.set(channel, listeners)
  }

  removeListener(
    channel: string,
    listener: (event: unknown, update: ActivityUpdate) => void
  ): void {
    this.listeners.get(channel)?.delete(listener)
  }

  emit(update: ActivityUpdate): void {
    for (const listener of this.listeners.get(activityUpdateChannel) ?? []) {
      listener(undefined, update)
    }
  }
}

test('activity preload invokes snapshots, forwards updates, and removes subscriptions', async () => {
  const ipc = new StubIpcRenderer()
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
