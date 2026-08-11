import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getApprovalConfiguration,
  setApprovalConfiguration,
  setApprovalMode,
  type ApprovalBackend,
  type ApprovalBackendRequestOptions
} from './approval.mts'

interface StubApprovalBackend extends ApprovalBackend {
  readonly calls: Array<{
    command: string
    fields?: Record<string, unknown>
    options?: ApprovalBackendRequestOptions
  }>
}

function stubApprovalBackend(...responses: readonly unknown[]): StubApprovalBackend {
  const calls: StubApprovalBackend['calls'] = []
  let responseIndex = 0
  return {
    calls,
    request: async (command, fields, options) => {
      calls.push({ command, fields, options })
      const response = responses[responseIndex]
      responseIndex += 1
      return response
    }
  }
}

test('approval configuration defaults to asking when the backend omits the mode', async () => {
  const backend = stubApprovalBackend({ config: { futureSetting: true } })

  assert.deepEqual(await getApprovalConfiguration(backend), {
    mode: 'manual',
    reviewerModelId: null
  })
  assert.deepEqual(backend.calls, [
    { command: 'config_get', fields: undefined, options: undefined }
  ])
})

test('approval mode updates preserve the configured reviewer model', async () => {
  const backend = stubApprovalBackend(
    { config: { approvalMode: 'manual', reviewerModel: 'reviewer' } },
    { models: [{ id: 'reviewer', name: 'Reviewer' }] },
    { config: { approvalMode: 'smart', reviewerModel: 'reviewer' } }
  )

  assert.deepEqual(await setApprovalMode(backend, 'smart'), {
    mode: 'smart',
    reviewerModelId: 'reviewer'
  })
  assert.deepEqual(backend.calls, [
    { command: 'config_get', fields: undefined, options: undefined },
    { command: 'get_available_models', fields: undefined, options: undefined },
    {
      command: 'config_update',
      fields: { patch: { approvalMode: 'smart' } },
      options: { timeout: 'none' }
    }
  ])
})

test('approval mode updates reject invalid input and auto approval without a reviewer', async () => {
  const invalidBackend = stubApprovalBackend()
  await assert.rejects(setApprovalMode(invalidBackend, 'always'), /Invalid approval mode/)
  assert.equal(invalidBackend.calls.length, 0)

  const missingReviewerBackend = stubApprovalBackend({
    config: { approvalMode: 'manual' }
  })
  await assert.rejects(setApprovalMode(missingReviewerBackend, 'smart'), /Choose an approval model/)
  assert.equal(missingReviewerBackend.calls.length, 1)

  const unavailableReviewerBackend = stubApprovalBackend(
    { config: { approvalMode: 'manual', reviewerModel: 'retired-reviewer' } },
    { models: [{ id: 'available-reviewer', name: 'Available reviewer' }] }
  )
  await assert.rejects(
    setApprovalMode(unavailableReviewerBackend, 'smart'),
    /available approval model/
  )
  assert.deepEqual(
    unavailableReviewerBackend.calls.map(({ command }) => command),
    ['config_get', 'get_available_models']
  )
})

test('approval configuration rejects malformed backend data', async () => {
  for (const response of [
    undefined,
    {},
    { config: [] },
    { config: { approvalMode: 'always' } },
    { config: { approvalMode: 'smart' } },
    { config: { reviewerModel: 'not valid' } }
  ]) {
    await assert.rejects(
      getApprovalConfiguration(stubApprovalBackend(response)),
      /invalid approval configuration/i
    )
  }
})

test('full approval updates save the reviewer and remove it with null', async () => {
  const selected = stubApprovalBackend(
    { running: false },
    { models: [{ id: 'reviewer', name: 'Reviewer' }] },
    { config: { approvalMode: 'smart', reviewerModel: 'reviewer', future: true } }
  )
  assert.deepEqual(
    await setApprovalConfiguration(selected, { mode: 'smart', reviewerModelId: 'reviewer' }),
    { mode: 'smart', reviewerModelId: 'reviewer' }
  )
  assert.deepEqual(selected.calls[2], {
    command: 'config_update',
    fields: { patch: { approvalMode: 'smart', reviewerModel: 'reviewer' } },
    options: { timeout: 'none' }
  })

  const removed = stubApprovalBackend(
    { running: false },
    { config: { approvalMode: 'manual', future: true } }
  )
  assert.deepEqual(
    await setApprovalConfiguration(removed, { mode: 'manual', reviewerModelId: null }),
    { mode: 'manual', reviewerModelId: null }
  )
  assert.deepEqual(removed.calls[1], {
    command: 'config_update',
    fields: { patch: { approvalMode: 'manual', reviewerModel: null } },
    options: { timeout: 'none' }
  })
})

test('non-smart approval preserves a retired reviewer without requiring it in the catalog', async () => {
  const backend = stubApprovalBackend(
    { running: false },
    { config: { approvalMode: 'manual', reviewerModel: 'retired-reviewer' } }
  )

  assert.deepEqual(
    await setApprovalConfiguration(backend, {
      mode: 'manual',
      reviewerModelId: 'retired-reviewer'
    }),
    { mode: 'manual', reviewerModelId: 'retired-reviewer' }
  )
  assert.deepEqual(
    backend.calls.map(({ command }) => command),
    ['get_state', 'config_update']
  )
})

test('full approval updates are rejected while a task is running', async () => {
  const backend = stubApprovalBackend({ running: true })

  await assert.rejects(
    setApprovalConfiguration(backend, { mode: 'manual', reviewerModelId: null }),
    /while a task is running/
  )
  assert.deepEqual(
    backend.calls.map(({ command }) => command),
    ['get_state']
  )
})
