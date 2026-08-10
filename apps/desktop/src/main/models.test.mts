import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getModelConfiguration,
  selectModel,
  type ModelBackend,
  type ModelBackendRequestOptions
} from './models.mts'

const catalog = {
  models: [
    { id: 'gpt-5', name: 'GPT-5' },
    { id: 'claude-sonnet', name: 'Claude Sonnet' }
  ]
}

interface StubResponse {
  error?: Error
  value?: unknown
}

interface StubModelBackend extends ModelBackend {
  readonly calls: Array<{
    command: string
    fields?: Record<string, unknown>
    options?: ModelBackendRequestOptions
  }>
}

function stubModelBackend(responses: Record<string, StubResponse[]>): StubModelBackend {
  const calls: StubModelBackend['calls'] = []
  const responseQueues = new Map(Object.entries(responses))
  return {
    calls,
    request: async (command, fields, options) => {
      calls.push({ command, fields, options })
      const response = responseQueues.get(command)?.shift()
      if (!response) {
        throw new Error(`Unexpected command: ${command}`)
      }
      if (response.error) {
        throw response.error
      }
      return response.value
    }
  }
}

function readableConfigurationResponses(): Record<string, StubResponse[]> {
  return {
    get_available_models: [{ value: catalog }],
    get_state: [{ value: { sessionId: 'session-one', model: 'gpt-5', running: false } }],
    config_get: [{ value: { config: { model: 'gpt-5' } } }]
  }
}

test('model configuration loads the available, active, and default models concurrently', async () => {
  const backend = stubModelBackend(readableConfigurationResponses())

  assert.deepEqual(await getModelConfiguration(backend), {
    activeSessionId: 'session-one',
    activeModelId: 'gpt-5',
    defaultModelId: 'gpt-5',
    isRunning: false,
    models: [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'claude-sonnet', name: 'Claude Sonnet' }
    ],
    warning: null
  })
  assert.deepEqual(
    backend.calls.map(({ command }) => command),
    ['get_available_models', 'get_state', 'config_get']
  )
})

test('model selection changes the active task before saving the future default', async () => {
  const backend = stubModelBackend({
    ...readableConfigurationResponses(),
    set_model: [
      {
        value: {
          sessionId: 'fork-session-one',
          model: 'claude-sonnet'
        }
      }
    ],
    config_update: [{ value: { config: { model: 'claude-sonnet' } } }]
  })

  assert.deepEqual(await selectModel(backend, 'claude-sonnet'), {
    activeSessionId: 'fork-session-one',
    activeModelId: 'claude-sonnet',
    defaultModelId: 'claude-sonnet',
    isRunning: false,
    models: [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'claude-sonnet', name: 'Claude Sonnet' }
    ],
    warning: null
  })
  assert.deepEqual(backend.calls.slice(3), [
    {
      command: 'set_model',
      fields: { modelId: 'claude-sonnet' },
      options: { timeout: 'none' }
    },
    {
      command: 'config_update',
      fields: { patch: { model: 'claude-sonnet' } },
      options: { timeout: 'none' }
    }
  ])
})

test('model selection preserves an active-task change when saving the default fails', async () => {
  const backend = stubModelBackend({
    ...readableConfigurationResponses(),
    get_state: [
      { value: { sessionId: 'session-one', model: 'gpt-5', running: false } },
      { value: { sessionId: 'fork-session-one', model: 'claude-sonnet', running: false } }
    ],
    set_model: [{ value: undefined }],
    config_update: [{ error: new Error('disk full') }]
  })

  assert.deepEqual(await selectModel(backend, 'claude-sonnet'), {
    activeSessionId: 'fork-session-one',
    activeModelId: 'claude-sonnet',
    defaultModelId: 'gpt-5',
    isRunning: false,
    models: [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'claude-sonnet', name: 'Claude Sonnet' }
    ],
    warning: 'This task changed to Claude Sonnet, but the default was not saved.'
  })
})

test('model configuration rejects malformed catalogs and unknown selections', async () => {
  const malformed = stubModelBackend({
    ...readableConfigurationResponses(),
    get_available_models: [
      {
        value: {
          models: [
            { id: 'duplicate', name: 'One' },
            { id: 'duplicate', name: 'Two' }
          ]
        }
      }
    ]
  })
  await assert.rejects(getModelConfiguration(malformed), /invalid model configuration/i)

  const unknown = stubModelBackend(readableConfigurationResponses())
  await assert.rejects(selectModel(unknown, 'missing'), /Invalid model selection/)
  assert.equal(unknown.calls.length, 3)
})
