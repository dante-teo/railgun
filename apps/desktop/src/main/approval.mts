import type { ApprovalConfiguration, ApprovalMode } from '../shared/approval-api.ts'
import { ensureConfigurationIsMutable, parseModelCatalog } from './models.mts'
import { asObject } from './value-validation.mts'

const approvalModes: readonly ApprovalMode[] = ['manual', 'smart', 'off']
const maximumModelIdLength = 256

export interface ApprovalBackendRequestOptions {
  timeout?: 'default' | 'none'
}

export interface ApprovalBackend {
  request(
    command: string,
    fields?: Record<string, unknown>,
    options?: ApprovalBackendRequestOptions
  ): Promise<unknown>
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && approvalModes.includes(value as ApprovalMode)
}

function parseReviewerModelId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null
  }
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumModelIdLength &&
    ![...value].some((character) => /\s/u.test(character))
    ? value
    : undefined
}

export function parseApprovalConfiguration(value: unknown): ApprovalConfiguration {
  const config = asObject(asObject(value)?.config)
  const mode = config?.approvalMode ?? 'manual'
  const reviewerModelId = parseReviewerModelId(config?.reviewerModel)
  if (
    !config ||
    !isApprovalMode(mode) ||
    reviewerModelId === undefined ||
    (mode === 'smart' && reviewerModelId === null)
  ) {
    throw new Error('The backend returned an invalid approval configuration')
  }
  return { mode, reviewerModelId }
}

export async function getApprovalConfiguration(
  backend: ApprovalBackend
): Promise<ApprovalConfiguration> {
  return parseApprovalConfiguration(await backend.request('config_get'))
}

export async function setApprovalMode(
  backend: ApprovalBackend,
  value: unknown
): Promise<ApprovalConfiguration> {
  if (!isApprovalMode(value)) {
    throw new Error('Invalid approval mode')
  }

  const current = await getApprovalConfiguration(backend)
  if (value === 'smart') {
    if (current.reviewerModelId === null) {
      throw new Error('Choose an approval model before enabling auto approval')
    }
    const models = parseModelCatalog(await backend.request('get_available_models'))
    if (!models.some(({ id }) => id === current.reviewerModelId)) {
      throw new Error('Choose an available approval model before enabling auto approval')
    }
  }

  const updated = parseApprovalConfiguration(
    await backend.request('config_update', { patch: { approvalMode: value } }, { timeout: 'none' })
  )
  if (updated.mode !== value) {
    throw new Error('The backend returned an invalid approval configuration')
  }
  return updated
}

function parseApprovalInput(value: unknown): ApprovalConfiguration {
  const configuration = asObject(value)
  const mode = configuration?.mode
  const reviewerModelId = parseReviewerModelId(configuration?.reviewerModelId)
  if (!isApprovalMode(mode) || reviewerModelId === undefined) {
    throw new Error('Invalid approval configuration')
  }
  return { mode, reviewerModelId }
}

export async function setApprovalConfiguration(
  backend: ApprovalBackend,
  value: unknown
): Promise<ApprovalConfiguration> {
  const requested = parseApprovalInput(value)
  await ensureConfigurationIsMutable(backend)
  if (requested.mode === 'smart' && requested.reviewerModelId === null) {
    throw new Error('Choose an approval model before enabling auto approval')
  }
  if (requested.mode === 'smart' && requested.reviewerModelId !== null) {
    const models = parseModelCatalog(await backend.request('get_available_models'))
    if (!models.some(({ id }) => id === requested.reviewerModelId)) {
      throw new Error('Choose an available approval model')
    }
  }

  const updated = parseApprovalConfiguration(
    await backend.request(
      'config_update',
      {
        patch: {
          approvalMode: requested.mode,
          reviewerModel: requested.reviewerModelId
        }
      },
      { timeout: 'none' }
    )
  )
  if (updated.mode !== requested.mode || updated.reviewerModelId !== requested.reviewerModelId) {
    throw new Error('The backend returned an invalid approval configuration')
  }
  return updated
}
