export const skillsListChannel = 'railgun:skills:list'
export const skillsGetChannel = 'railgun:skills:get'
export const skillsCreateChannel = 'railgun:skills:create'
export const skillsUpdateChannel = 'railgun:skills:update'
export const skillsDeleteChannel = 'railgun:skills:delete'

export interface SkillSummary {
  readonly name: string
  readonly description: string
  readonly allowModelInvocation: boolean
}

export interface ManagedSkill extends SkillSummary {
  readonly body: string
}

export interface SkillInput {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly allowModelInvocation: boolean
}

export interface SkillApi {
  list: () => Promise<readonly SkillSummary[]>
  get: (name: string) => Promise<ManagedSkill>
  create: (input: SkillInput) => Promise<ManagedSkill>
  update: (name: string, input: Omit<SkillInput, 'name'>) => Promise<ManagedSkill>
  delete: (name: string) => Promise<void>
}
