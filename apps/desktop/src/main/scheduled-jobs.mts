import type {
  ScheduledJob,
  ScheduledJobCreateInput,
  ScheduledJobInput,
  ScheduledJobLastStatus
} from '../shared/scheduler-api.ts'
import { normalizeCronSchedule, normalizeStoredCronSchedule } from '../shared/cron-schedule.ts'
import { asObject } from './value-validation.mts'

const newJobNamePattern = /^[a-z0-9-]{1,64}$/u
const maximumLegacyNameLength = 512
const maximumPromptLength = 20_000
const maximumErrorLength = 512
const listPageSize = 50
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u
const statuses = new Set<ScheduledJobLastStatus>(['completed', 'failed'])

export interface ScheduledJobsRequestOptions {
  readonly timeout?: 'default' | 'none'
}

export interface ScheduledJobsBackend {
  request(
    command: string,
    fields?: Record<string, unknown>,
    options?: ScheduledJobsRequestOptions
  ): Promise<unknown>
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function validateExistingJobName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > maximumLegacyNameLength ||
    containsControlCharacter(value)
  ) {
    throw new Error('Invalid scheduled job name')
  }
  return value
}

function validateNewJobName(value: unknown): string {
  if (typeof value !== 'string' || !newJobNamePattern.test(value)) {
    throw new Error('Invalid scheduled job name')
  }
  return value
}

function validatePrompt(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid scheduled job prompt')
  }
  const prompt = value.trim()
  if (!prompt || prompt.length > maximumPromptLength) {
    throw new Error('Invalid scheduled job prompt')
  }
  return prompt
}

function parseLastRunAt(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const validNumber = typeof value === 'number' && Number.isInteger(value) && value >= 0
  const validString = typeof value === 'string' && isoTimestampPattern.test(value)
  const milliseconds = validNumber ? value : validString ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error('The backend returned an invalid scheduled job timestamp')
  }
  try {
    return new Date(milliseconds).toISOString()
  } catch {
    throw new Error('The backend returned an invalid scheduled job timestamp')
  }
}

function parseLastStatus(value: unknown): ScheduledJobLastStatus | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !statuses.has(value as ScheduledJobLastStatus)) {
    throw new Error('The backend returned an invalid scheduled job status')
  }
  return value as ScheduledJobLastStatus
}

function parseLastError(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new Error('The backend returned an invalid scheduled job error')
  }
  return value.slice(0, maximumErrorLength)
}

function parseJob(value: unknown): ScheduledJob {
  const fields = asObject(value)
  if (!fields) {
    throw new Error('The backend returned an invalid scheduled job')
  }
  const lastRunAt = parseLastRunAt(fields.lastRun)
  const lastStatus = parseLastStatus(fields.lastStatus)
  if (lastStatus && !lastRunAt) {
    throw new Error('The backend returned an invalid scheduled job run state')
  }
  return {
    name: validateExistingJobName(fields.id),
    schedule: normalizeStoredCronSchedule(fields.schedule),
    prompt: validatePrompt(fields.prompt),
    lastRunAt,
    lastStatus,
    lastError: parseLastError(fields.lastError)
  }
}

function parseInput(value: unknown): ScheduledJobInput {
  const fields = asObject(value)
  if (!fields) throw new Error('Invalid scheduled job')
  return {
    schedule: normalizeCronSchedule(fields.schedule),
    prompt: validatePrompt(fields.prompt)
  }
}

function parseCreateInput(value: unknown): ScheduledJobCreateInput {
  const fields = asObject(value)
  if (!fields) throw new Error('Invalid scheduled job')
  return { name: validateNewJobName(fields.name), ...parseInput(fields) }
}

function parseMutationJob(value: unknown, expectedName: string): ScheduledJob {
  const job = parseJob(asObject(value)?.job)
  if (job.name !== expectedName) {
    throw new Error('The backend returned an invalid scheduled job')
  }
  return job
}

export class ScheduledJobService {
  private readonly backend: ScheduledJobsBackend

  constructor(backend: ScheduledJobsBackend) {
    this.backend = backend
  }

  async listJobs(): Promise<ScheduledJob[]> {
    const jobs: ScheduledJob[] = []
    let cursor = 0
    while (true) {
      const data = asObject(
        await this.backend.request('cron_list', {
          cursor,
          editableOnly: true,
          limit: listPageSize,
          maxPromptLength: maximumPromptLength
        })
      )
      if (!data || !Array.isArray(data.jobs)) {
        throw new Error('The backend returned an invalid scheduled job list')
      }
      jobs.push(...data.jobs.map(parseJob))
      if (data.nextCursor === undefined) return jobs
      if (
        typeof data.nextCursor !== 'number' ||
        !Number.isSafeInteger(data.nextCursor) ||
        data.nextCursor <= cursor
      ) {
        throw new Error('The backend returned an invalid scheduled job cursor')
      }
      cursor = data.nextCursor
    }
  }

  async createJob(value: unknown): Promise<ScheduledJob> {
    const input = parseCreateInput(value)
    return parseMutationJob(
      await this.backend.request(
        'cron_add',
        {
          includeJob: true,
          jobId: input.name,
          prompt: input.prompt,
          schedule: input.schedule
        },
        { timeout: 'none' }
      ),
      input.name
    )
  }

  async updateJob(nameValue: unknown, value: unknown): Promise<ScheduledJob> {
    const name = validateExistingJobName(nameValue)
    const input = parseInput(value)
    return parseMutationJob(
      await this.backend.request(
        'cron_update',
        {
          includeJob: true,
          jobId: name,
          patch: { prompt: input.prompt, schedule: input.schedule }
        },
        { timeout: 'none' }
      ),
      name
    )
  }

  async deleteJob(nameValue: unknown): Promise<void> {
    const name = validateExistingJobName(nameValue)
    await this.backend.request('cron_remove', { jobId: name }, { timeout: 'none' })
  }
}
