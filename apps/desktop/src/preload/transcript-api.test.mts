import assert from 'node:assert/strict'
import test from 'node:test'

import {
  emptyTranscriptSnapshot,
  transcriptAbortChannel,
  transcriptApprovalResponseChannel,
  transcriptClarificationResponseChannel,
  transcriptSendChannel,
  transcriptSnapshotChannel,
  transcriptUpdateChannel,
  type TranscriptUpdate
} from '../shared/transcript-api.ts'
import { createTranscriptApi, type TranscriptIpcRenderer } from './transcript-api.mts'

interface StubIpcRenderer extends TranscriptIpcRenderer {
  readonly invocations: Array<readonly [string, ...unknown[]]>
  readonly listeners: Map<string, Set<(event: unknown, update: TranscriptUpdate) => void>>
  readonly emit: (update: TranscriptUpdate) => void
}

function stubIpcRenderer(): StubIpcRenderer {
  const invocations: Array<readonly [string, ...unknown[]]> = []
  const listeners = new Map<string, Set<(event: unknown, update: TranscriptUpdate) => void>>()
  return {
    invocations,
    listeners,
    invoke: async (channel, ...arguments_) => {
      invocations.push([channel, ...arguments_])
      return channel === transcriptSnapshotChannel ? emptyTranscriptSnapshot() : undefined
    },
    on: (channel, listener) => {
      const channelListeners = listeners.get(channel) ?? new Set()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    },
    removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
    emit: (update) =>
      listeners.get(transcriptUpdateChannel)?.forEach((listener) => listener(undefined, update))
  }
}

test('transcript preload invokes commands, forwards updates, and removes subscriptions', async () => {
  const ipc = stubIpcRenderer()
  const api = createTranscriptApi(ipc)
  const received: TranscriptUpdate[] = []
  const unsubscribe = api.subscribe((update) => received.push(update))
  const update = {
    revision: 1,
    snapshot: { ...emptyTranscriptSnapshot(), revision: 1 }
  }
  const submission = {
    text: 'Inspect',
    attachments: [{ kind: 'file', name: 'notes.txt', path: '/tmp/notes.txt' }] as const
  }

  assert.deepEqual(await api.getSnapshot(), emptyTranscriptSnapshot())
  await api.send('session-one', submission)
  await api.abort('session-one')
  await api.respondToApproval('session-one', 'approval-one', true)
  await api.respondToClarification('session-one', 'clarification-one', 'Use the safe path')
  ipc.emit(update)
  unsubscribe()
  ipc.emit({ revision: 2, snapshot: { ...emptyTranscriptSnapshot(), revision: 2 } })

  assert.deepEqual(ipc.invocations, [
    [transcriptSnapshotChannel],
    [transcriptSendChannel, 'session-one', submission],
    [transcriptAbortChannel, 'session-one'],
    [transcriptApprovalResponseChannel, 'session-one', 'approval-one', true],
    [
      transcriptClarificationResponseChannel,
      'session-one',
      'clarification-one',
      'Use the safe path'
    ]
  ])
  assert.deepEqual(received, [update])
  assert.equal(ipc.listeners.get(transcriptUpdateChannel)?.size, 0)
})
