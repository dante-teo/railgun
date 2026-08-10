import assert from 'node:assert/strict'
import test from 'node:test'

import {
  approvalGetChannel,
  approvalSetModeChannel,
  type ApprovalConfiguration
} from '../shared/approval-api.ts'
import { createApprovalApi } from './approval-api.mts'

test('approval preload gets and updates the mode through narrow IPC channels', async () => {
  const configuration: ApprovalConfiguration = {
    mode: 'manual',
    reviewerModelId: 'reviewer'
  }
  const calls: Array<{ arguments: readonly unknown[]; channel: string }> = []
  const api = createApprovalApi({
    invoke: async (channel, ...args) => {
      calls.push({ arguments: args, channel })
      return configuration
    }
  })

  assert.deepEqual(await api.get(), configuration)
  assert.deepEqual(await api.setMode('off'), configuration)
  assert.deepEqual(calls, [
    { arguments: [], channel: approvalGetChannel },
    { arguments: ['off'], channel: approvalSetModeChannel }
  ])
})
