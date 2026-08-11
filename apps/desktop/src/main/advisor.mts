import type { AdvisorConfiguration } from '../shared/advisor-api.ts'
import { ensureConfigurationIsMutable, parseModelCatalog } from './models.mts'
import { asObject } from './value-validation.mts'

const maximumModelIdLength = 256

export interface AdvisorBackend {
  request(
    command: string,
    fields?: Record<string, unknown>,
    options?: { timeout?: 'default' | 'none' }
  ): Promise<unknown>
}

function modelId(value: unknown): string | null | undefined {
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

export function parseAdvisorConfiguration(value: unknown): AdvisorConfiguration {
  const config = asObject(asObject(value)?.config)
  const advisor = asObject(config?.advisor) ?? {}
  const enabled = advisor.enabled ?? false
  const parsedModelId = modelId(advisor.model)
  if (typeof enabled !== 'boolean' || parsedModelId === undefined || (enabled && !parsedModelId)) {
    throw new Error('The backend returned an invalid advisor configuration')
  }
  return { enabled, modelId: parsedModelId }
}

function parseAdvisorInput(value: unknown): AdvisorConfiguration {
  const input = asObject(value)
  const enabled = input?.enabled
  const parsedModelId = modelId(input?.modelId)
  if (typeof enabled !== 'boolean' || parsedModelId === undefined || (enabled && !parsedModelId)) {
    throw new Error('Invalid advisor configuration')
  }
  return { enabled, modelId: parsedModelId }
}

export async function getAdvisorConfiguration(
  backend: AdvisorBackend
): Promise<AdvisorConfiguration> {
  return parseAdvisorConfiguration(await backend.request('config_get'))
}

export async function setAdvisorConfiguration(
  backend: AdvisorBackend,
  value: unknown
): Promise<AdvisorConfiguration> {
  const requested = parseAdvisorInput(value)
  await ensureConfigurationIsMutable(backend)
  if (requested.modelId !== null) {
    const models = parseModelCatalog(await backend.request('get_available_models'))
    if (!models.some(({ id }) => id === requested.modelId)) {
      throw new Error('Choose an available advisor model')
    }
  }

  const currentResponse = await backend.request('config_get')
  const currentConfig = asObject(asObject(currentResponse)?.config)
  const currentAdvisor = asObject(currentConfig?.advisor) ?? {}
  const nextAdvisor =
    requested.modelId === null
      ? {
          ...Object.fromEntries(Object.entries(currentAdvisor).filter(([key]) => key !== 'model')),
          enabled: requested.enabled
        }
      : { ...currentAdvisor, enabled: requested.enabled, model: requested.modelId }
  const updated = parseAdvisorConfiguration(
    await backend.request('config_update', { patch: { advisor: nextAdvisor } }, { timeout: 'none' })
  )
  if (updated.enabled !== requested.enabled || updated.modelId !== requested.modelId) {
    throw new Error('The backend returned an invalid advisor configuration')
  }
  return updated
}
