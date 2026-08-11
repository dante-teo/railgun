import type { ModelConfiguration, ModelOption } from '../shared/model-api.ts'
import { validateSessionId } from './tasks.mts'
import { asObject } from './value-validation.mts'

const maximumModels = 256
const maximumModelIdLength = 256
const maximumModelNameLength = 500

export interface ModelBackendRequestOptions {
  timeout?: 'default' | 'none'
}

export interface ModelBackend {
  request(
    command: string,
    fields?: Record<string, unknown>,
    options?: ModelBackendRequestOptions
  ): Promise<unknown>
}

function validModelId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumModelIdLength &&
    ![...value].some((character) => /\s/u.test(character))
    ? value
    : undefined
}

function validModelName(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximumModelNameLength
    ? value
    : undefined
}

export function parseModelCatalog(value: unknown): readonly ModelOption[] {
  const rawModels = asObject(value)?.models
  if (!Array.isArray(rawModels) || rawModels.length === 0 || rawModels.length > maximumModels) {
    throw new Error('The backend returned an invalid model configuration')
  }

  const models = rawModels.map((rawModel) => {
    const model = asObject(rawModel)
    const id = validModelId(model?.id)
    const name = validModelName(model?.name)
    if (!id || !name) {
      throw new Error('The backend returned an invalid model configuration')
    }
    return { id, name }
  })
  if (new Set(models.map(({ id }) => id)).size !== models.length) {
    throw new Error('The backend returned an invalid model configuration')
  }
  return models
}

function parseActiveIdentity(value: unknown): Pick<
  ModelConfiguration,
  'activeModelId' | 'activeSessionId'
> & {
  readonly fields: Record<string, unknown>
} {
  const state = asObject(value)
  const activeModelId = validModelId(state?.model)
  let activeSessionId: string
  try {
    activeSessionId = validateSessionId(state?.sessionId)
  } catch {
    throw new Error('The backend returned an invalid model configuration')
  }
  if (!state || !activeModelId) {
    throw new Error('The backend returned an invalid model configuration')
  }
  return { activeModelId, activeSessionId, fields: state }
}

function parseActiveState(
  value: unknown
): Pick<ModelConfiguration, 'activeModelId' | 'activeSessionId' | 'isRunning'> {
  const { fields, ...identity } = parseActiveIdentity(value)
  if (typeof fields.running !== 'boolean') {
    throw new Error('The backend returned an invalid model configuration')
  }
  return { ...identity, isRunning: fields.running }
}

function parseModelChange(
  value: unknown
): Pick<ModelConfiguration, 'activeModelId' | 'activeSessionId' | 'isRunning'> {
  const { fields, ...identity } = parseActiveIdentity(value)
  if (fields.running !== undefined && fields.running !== false) {
    throw new Error('The backend returned an invalid model configuration')
  }
  return { ...identity, isRunning: false }
}

function parseDefaultModelId(value: unknown): string | null {
  const config = asObject(asObject(value)?.config)
  if (!config) {
    throw new Error('The backend returned an invalid model configuration')
  }
  if (config.model === undefined || config.model === null) {
    return null
  }
  const modelId = validModelId(config.model)
  if (!modelId) {
    throw new Error('The backend returned an invalid model configuration')
  }
  return modelId
}

export async function getConfiguredDefaultModelId(backend: ModelBackend): Promise<string | null> {
  const [config, catalog] = await Promise.all([
    backend.request('config_get'),
    backend.request('get_available_models')
  ])
  const modelId = parseDefaultModelId(config)
  const models = parseModelCatalog(catalog)
  return modelId && models.some(({ id }) => id === modelId) ? modelId : null
}

export async function getModelConfiguration(backend: ModelBackend): Promise<ModelConfiguration> {
  const [catalog, state, config] = await Promise.all([
    backend.request('get_available_models'),
    backend.request('get_state'),
    backend.request('config_get')
  ])
  const models = parseModelCatalog(catalog)
  const active = parseActiveState(state)
  if (!models.some(({ id }) => id === active.activeModelId)) {
    throw new Error('The backend returned an invalid model configuration')
  }
  return {
    ...active,
    defaultModelId: parseDefaultModelId(config),
    models,
    warning: null
  }
}

export async function selectModel(
  backend: ModelBackend,
  value: unknown
): Promise<ModelConfiguration> {
  const modelId = validModelId(value)
  if (!modelId) {
    throw new Error('Invalid model selection')
  }

  const current = await getModelConfiguration(backend)
  const selected = current.models.find(({ id }) => id === modelId)
  if (!selected) {
    throw new Error('Invalid model selection')
  }
  if (current.isRunning) {
    throw new Error('Cannot change models while the task is running')
  }

  const changedState = await backend.request('set_model', { modelId }, { timeout: 'none' })
  const active =
    changedState === undefined
      ? parseActiveState(await backend.request('get_state'))
      : parseModelChange(changedState)
  if (active.activeModelId !== modelId || active.isRunning) {
    throw new Error('The backend returned an invalid model configuration')
  }
  const activeConfiguration = { ...current, ...active }
  try {
    const updated = await backend.request(
      'config_update',
      { patch: { model: modelId } },
      { timeout: 'none' }
    )
    if (parseDefaultModelId(updated) !== modelId) {
      throw new Error('The backend did not save the selected default model')
    }
    return { ...activeConfiguration, defaultModelId: modelId }
  } catch {
    return {
      ...activeConfiguration,
      warning: `This task changed to ${selected.name}, but the default was not saved.`
    }
  }
}
