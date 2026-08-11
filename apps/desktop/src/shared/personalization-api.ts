export const soulGetChannel = 'railgun:personalization:soul:get'
export const soulSetChannel = 'railgun:personalization:soul:set'
export const memoriesListChannel = 'railgun:personalization:memories:list'
export const memoriesCreateChannel = 'railgun:personalization:memories:create'
export const memoriesUpdateChannel = 'railgun:personalization:memories:update'
export const memoriesDeleteChannel = 'railgun:personalization:memories:delete'

export type MemoryCategory = 'preference' | 'fact' | 'project'

export interface MemoryRecord {
  readonly id: string
  readonly content: string
  readonly category: MemoryCategory
  readonly createdAt: number
}

export interface MemoryInput {
  readonly content: string
  readonly category: MemoryCategory
}

export interface PersonalizationApi {
  soul: {
    get: () => Promise<string>
    set: (content: string) => Promise<string>
  }
  memories: {
    list: (query?: string) => Promise<readonly MemoryRecord[]>
    create: (input: MemoryInput) => Promise<MemoryRecord>
    update: (memoryId: string, input: MemoryInput) => Promise<MemoryRecord>
    delete: (memoryId: string) => Promise<void>
  }
}
