import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getApprovalConfiguration,
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
