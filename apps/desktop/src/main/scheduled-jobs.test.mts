import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ScheduledJobService,
  type ScheduledJobsBackend,
  type ScheduledJobsRequestOptions
} from './scheduled-jobs.mts'

interface StubBackend extends ScheduledJobsBackend {
  readonly calls: Array<{
    command: string
    fields?: Record<string, unknown>
    options?: ScheduledJobsRequestOptions
  }>
}

function stubBackend(responses: readonly unknown[], failure?: Error): StubBackend {
  const calls: StubBackend['calls'] = []
  const queued = [...responses]
  return {
    calls,
    request: async (command, fields, options) => {
      calls.push({ command, fields, options })
      if (failure) throw failure
      return queued.shift()
    }
  }
}

const backendJob = {
  id: 'morning-brief',
  schedule: '0 9 * * 1-5',
  prompt: 'Prepare the morning brief',
  lastRun: 1_752_500_000_000,
  lastStatus: 'failed',
  lastError: 'Provider unavailable',
  requiredOutputs: ['/private/path']
}

test('ScheduledJobService maps and narrows listed jobs with legacy run compatibility', async () => {
  const backend = stubBackend([
    {
      jobs: [
        backendJob,
        {
          id: 'Legacy Job ID',
          schedule: '  0   9 1/2 * *  ',
          prompt: 'Legacy prompt',
          lastRun: '2026-08-12T03:00:00+00:00'
        }
      ]
    }
  ])

  assert.deepEqual(await new ScheduledJobService(backend).listJobs(), [
    {
      name: 'morning-brief',
      schedule: '0 9 * * 1-5',
      prompt: 'Prepare the morning brief',
      lastRunAt: '2025-07-14T13:33:20.000Z',
      lastStatus: 'failed',
      lastError: 'Provider unavailable'
    },
    {
      name: 'Legacy Job ID',
      schedule: '0 9 1/2 * *',
      prompt: 'Legacy prompt',
      lastRunAt: '2026-08-12T03:00:00.000Z',
      lastStatus: null,
      lastError: null
    }
  ])
  assert.deepEqual(backend.calls, [
    {
      command: 'cron_list',
      fields: { cursor: 0, editableOnly: true, limit: 50, maxPromptLength: 20_000 },
      options: undefined
    }
  ])
})

test('ScheduledJobService collects bounded pages and rejects invalid cursor progress', async () => {
  const backend = stubBackend([
    { jobs: [backendJob], nextCursor: 1 },
    { jobs: [{ ...backendJob, id: 'second-job' }] }
  ])

  assert.deepEqual(
    (await new ScheduledJobService(backend).listJobs()).map(({ name }) => name),
    ['morning-brief', 'second-job']
  )
  assert.deepEqual(
    backend.calls.map(({ fields }) => fields),
    [
      { cursor: 0, editableOnly: true, limit: 50, maxPromptLength: 20_000 },
      { cursor: 1, editableOnly: true, limit: 50, maxPromptLength: 20_000 }
    ]
  )

  for (const nextCursor of [-1, 0, 1.5, '1']) {
    await assert.rejects(
      new ScheduledJobService(stubBackend([{ jobs: [], nextCursor }])).listJobs(),
      /cursor/i
    )
  }
})

test('ScheduledJobService maps CRUD commands exactly and requests mutation jobs', async () => {
  const created = { ...backendJob, lastRun: null, lastStatus: null, lastError: null }
  const updated = { ...created, schedule: '0 * * * *', prompt: 'Updated prompt' }
  const backend = stubBackend([{ job: created }, { job: updated }, undefined])
  const service = new ScheduledJobService(backend)

  assert.equal(
    (
      await service.createJob({
        name: 'morning-brief',
        schedule: ' 0  9 * * 1-5 ',
        prompt: '  Prepare the morning brief  '
      })
    ).name,
    'morning-brief'
  )
  assert.deepEqual(
    await service.updateJob('morning-brief', {
      schedule: '0 * * * *',
      prompt: ' Updated prompt '
    }),
    {
      name: 'morning-brief',
      schedule: '0 * * * *',
      prompt: 'Updated prompt',
      lastRunAt: null,
      lastStatus: null,
      lastError: null
    }
  )
  await service.deleteJob('morning-brief')

  assert.deepEqual(backend.calls, [
    {
      command: 'cron_add',
      fields: {
        includeJob: true,
        jobId: 'morning-brief',
        prompt: 'Prepare the morning brief',
        schedule: '0 9 * * 1-5'
      },
      options: { timeout: 'none' }
    },
    {
      command: 'cron_update',
      fields: {
        includeJob: true,
        jobId: 'morning-brief',
        patch: { prompt: 'Updated prompt', schedule: '0 * * * *' }
      },
      options: { timeout: 'none' }
    },
    {
      command: 'cron_remove',
      fields: { jobId: 'morning-brief' },
      options: { timeout: 'none' }
    }
  ])
})

test('ScheduledJobService validates renderer input before RPC while legacy names remain mutable', async () => {
  const backend = stubBackend([
    { job: { ...backendJob, id: 'stepped-job', schedule: '0 9 1/2 * *' } },
    { job: { ...backendJob, id: 'Legacy Job ID' } },
    undefined
  ])
  const service = new ScheduledJobService(backend)

  for (const name of ['', 'Uppercase', 'has spaces', 'a'.repeat(65)]) {
    await assert.rejects(
      service.createJob({ name, schedule: '0 9 * * *', prompt: 'Prompt' }),
      /name/i
    )
  }
  for (const schedule of ['', '* * * * * *', '60 * * * *', '? 9 * * *', '0 9 * JAN *']) {
    await assert.rejects(
      service.createJob({ name: 'valid-name', schedule, prompt: 'Prompt' }),
      /schedule/i
    )
  }
  await assert.rejects(
    service.createJob({ name: 'valid-name', schedule: '0 9 * * *', prompt: '  ' }),
    /prompt/i
  )
  assert.equal(backend.calls.length, 0)

  await service.createJob({
    name: 'stepped-job',
    schedule: '0 9 1/2 * *',
    prompt: 'Prompt'
  })

  await service.updateJob('Legacy Job ID', { schedule: '0 9 * * *', prompt: 'Prompt' })
  await service.deleteJob('Legacy Job ID')
  assert.equal(backend.calls.length, 3)
})

test('ScheduledJobService rejects malformed backend projections and bounds run errors', async () => {
  const malformed = [
    undefined,
    { jobs: null },
    { jobs: [{ ...backendJob, id: '' }] },
    { jobs: [{ ...backendJob, schedule: '* * * * * *' }] },
    { jobs: [{ ...backendJob, prompt: ' ' }] },
    { jobs: [{ ...backendJob, lastRun: 'not-a-date' }] },
    { jobs: [{ ...backendJob, lastRun: '2026-08-12' }] },
    { jobs: [{ ...backendJob, lastRun: -1 }] },
    { jobs: [{ ...backendJob, lastRun: null, lastStatus: 'completed' }] },
    { jobs: [{ ...backendJob, lastStatus: 'running' }] },
    { jobs: [{ ...backendJob, lastError: 42 }] }
  ]
  for (const response of malformed) {
    await assert.rejects(new ScheduledJobService(stubBackend([response])).listJobs(), /invalid/i)
  }

  const result = await new ScheduledJobService(
    stubBackend([{ jobs: [{ ...backendJob, lastError: 'x'.repeat(2_000) }] }])
  ).listJobs()
  assert.equal(result[0].lastError?.length, 512)
})

test('ScheduledJobService rejects missing or mismatched returned jobs and preserves RPC failures', async () => {
  await assert.rejects(
    new ScheduledJobService(stubBackend([{}])).createJob({
      name: 'morning-brief',
      schedule: '0 9 * * *',
      prompt: 'Prompt'
    }),
    /invalid/i
  )
  await assert.rejects(
    new ScheduledJobService(stubBackend([{ job: { ...backendJob, id: 'other' } }])).updateJob(
      'morning-brief',
      { schedule: '0 9 * * *', prompt: 'Prompt' }
    ),
    /invalid/i
  )

  const failure = new Error('cron store is locked')
  const service = new ScheduledJobService(stubBackend([], failure))
  await assert.rejects(service.listJobs(), failure)
  await assert.rejects(
    service.createJob({ name: 'morning-brief', schedule: '0 9 * * *', prompt: 'Prompt' }),
    failure
  )
  await assert.rejects(
    service.updateJob('morning-brief', { schedule: '0 9 * * *', prompt: 'Prompt' }),
    failure
  )
  await assert.rejects(service.deleteJob('morning-brief'), failure)
})
