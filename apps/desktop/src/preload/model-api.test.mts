import assert from 'node:assert/strict'
import test from 'node:test'

import {
  modelsGetChannel,
  modelsSelectChannel,
  modelsSetDefaultChannel,
  type ModelConfiguration
} from '../shared/model-api.ts'
import { createModelApi } from './model-api.mts'

test('model preload loads and selects through narrow IPC channels', async () => {
  const configuration: ModelConfiguration = {
    activeSessionId: 'session-one',
    activeModelId: 'gpt-5',
    defaultModelId: 'gpt-5',
    isRunning: false,
    models: [{ id: 'gpt-5', name: 'GPT-5' }],
    warning: null
  }
  const calls: Array<{ arguments: readonly unknown[]; channel: string }> = []
  const api = createModelApi({
    invoke: async (channel, ...args) => {
      calls.push({ arguments: args, channel })
      return configuration
    }
  })

  assert.deepEqual(await api.get(), configuration)
  assert.deepEqual(await api.select('gpt-5'), configuration)
  assert.deepEqual(await api.setDefault(null), configuration)
  assert.deepEqual(calls, [
    { arguments: [], channel: modelsGetChannel },
    { arguments: ['gpt-5'], channel: modelsSelectChannel },
    { arguments: [null], channel: modelsSetDefaultChannel }
  ])
})
