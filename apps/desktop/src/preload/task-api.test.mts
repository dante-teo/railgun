import assert from 'node:assert/strict'
import test from 'node:test'

import {
  tasksArchiveChannel,
  tasksCreateChannel,
  tasksDeleteAllArchivedChannel,
  tasksDeleteArchivedChannel,
  tasksListArchivedChannel,
  tasksListChannel,
  tasksOpenChannel,
  tasksUnarchiveChannel
} from '../shared/task-api.ts'
import { createTaskApi, type TaskIpcRenderer } from './task-api.mts'

test('task preload lists, creates, opens, and archives through narrow IPC channels', async () => {
  const invocations: Array<readonly [string, ...unknown[]]> = []
  const ipc: TaskIpcRenderer = {
    invoke: async (channel, ...arguments_) => {
      invocations.push([channel, ...arguments_])
      if (channel === tasksListChannel) {
        return []
      }
      if (channel === tasksListArchivedChannel) return []
      if (channel === tasksDeleteAllArchivedChannel) return 2
      return channel === tasksCreateChannel ? 'new-session' : undefined
    }
  }
  const api = createTaskApi(ipc)

  assert.deepEqual(await api.list(), [])
  assert.equal(await api.create(), 'new-session')
  await api.open('saved-session')
  await api.archive('saved-session')
  assert.deepEqual(await api.listArchived(), [])
  await api.unarchive('saved-session')
  await api.deleteArchived('saved-session')
  assert.equal(await api.deleteAllArchived(), 2)

  assert.deepEqual(invocations, [
    [tasksListChannel],
    [tasksCreateChannel],
    [tasksOpenChannel, 'saved-session'],
    [tasksArchiveChannel, 'saved-session'],
    [tasksListArchivedChannel],
    [tasksUnarchiveChannel, 'saved-session'],
    [tasksDeleteArchivedChannel, 'saved-session'],
    [tasksDeleteAllArchivedChannel]
  ])
})
