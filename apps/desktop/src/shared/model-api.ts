export const modelsGetChannel = 'railgun:models:get'
export const modelsSelectChannel = 'railgun:models:select'

export interface ModelOption {
  readonly id: string
  readonly name: string
}

export interface ModelConfiguration {
  readonly activeModelId: string
  readonly defaultModelId: string | null
  readonly isRunning: boolean
  readonly models: readonly ModelOption[]
  readonly warning: string | null
}

export interface ModelApi {
  get: () => Promise<ModelConfiguration>
  select: (modelId: string) => Promise<ModelConfiguration>
}
