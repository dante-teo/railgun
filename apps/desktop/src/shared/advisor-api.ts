export const advisorGetChannel = 'railgun:advisor:get'
export const advisorSetChannel = 'railgun:advisor:set'

export interface AdvisorConfiguration {
  readonly enabled: boolean
  readonly modelId: string | null
}

export interface AdvisorApi {
  get: () => Promise<AdvisorConfiguration>
  set: (configuration: AdvisorConfiguration) => Promise<AdvisorConfiguration>
}
