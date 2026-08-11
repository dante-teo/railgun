import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getAdvisorConfiguration,
  setAdvisorConfiguration,
  type AdvisorBackend
} from './advisor.mts'

test('advisor updates preserve unknown nested fields and validate selected models', async () => {
  const calls: Array<{ command: string; fields?: Record<string, unknown> }> = []
  const responses = [
    { running: false },
    { models: [{ id: 'advisor-model', name: 'Advisor' }] },
    { config: { advisor: { enabled: false, model: 'advisor-model', future: 42 } } },
    { config: { advisor: { enabled: true, model: 'advisor-model', future: 42 } } }
  ]
  const backend: AdvisorBackend = {
    request: async (command, fields) => {
      calls.push({ command, fields })
      return responses.shift()
    }
  }

  assert.deepEqual(
    await setAdvisorConfiguration(backend, { enabled: true, modelId: 'advisor-model' }),
    { enabled: true, modelId: 'advisor-model' }
  )
  assert.deepEqual(calls[3].fields, {
    patch: { advisor: { enabled: true, model: 'advisor-model', future: 42 } }
  })
})

test('advisor updates are rejected while a task is running', async () => {
  const calls: string[] = []
  const backend: AdvisorBackend = {
    request: async (command) => {
      calls.push(command)
      return { running: true }
    }
  }

  await assert.rejects(
    setAdvisorConfiguration(backend, { enabled: false, modelId: null }),
    /while a task is running/
  )
  assert.deepEqual(calls, ['get_state'])
})

test('advisor reads unavailable stored model IDs without rewriting them', async () => {
  const backend: AdvisorBackend = {
    request: async () => ({ config: { advisor: { enabled: false, model: 'retired-model' } } })
  }
  assert.deepEqual(await getAdvisorConfiguration(backend), {
    enabled: false,
    modelId: 'retired-model'
  })
})
