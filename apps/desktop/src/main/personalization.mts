import type { MemoryCategory, MemoryInput, MemoryRecord } from '../shared/personalization-api.ts'
import { asObject } from './value-validation.mts'

const categories = new Set<MemoryCategory>(['preference', 'fact', 'project'])
const maximumContentLength = 20_000
const maximumIdentifierLength = 512

export interface PersonalizationBackend {
  request(
    command: string,
    fields?: Record<string, unknown>,
    options?: { timeout?: 'default' | 'none' }
  ): Promise<unknown>
}

function nonEmptyIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximumIdentifierLength
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function parseMemoryInput(value: unknown): MemoryInput {
  const input = asObject(value)
  const content = input?.content
  const category = input?.category
  if (
    typeof content !== 'string' ||
    !content.trim() ||
    content.length > maximumContentLength ||
    typeof category !== 'string' ||
    !categories.has(category as MemoryCategory)
  ) {
    throw new Error('Invalid memory')
  }
  return { content: content.trim(), category: category as MemoryCategory }
}

function parseMemory(value: unknown): MemoryRecord {
  const memory = asObject(value)
  const input = parseMemoryInput(memory)
  const createdAt = memory?.createdAt
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
    throw new Error('The backend returned an invalid memory')
  }
  return {
    id: nonEmptyIdentifier(memory?.id, 'memory identifier'),
    ...input,
    createdAt
  }
}

function parseMemoryResponse(value: unknown): MemoryRecord {
  const memory = asObject(value)?.memory
  if (!memory) {
    throw new Error('The backend returned an invalid memory')
  }
  return parseMemory(memory)
}

export class PersonalizationService {
  private readonly backend: PersonalizationBackend

  constructor(backend: PersonalizationBackend) {
    this.backend = backend
  }

  async getSoul(): Promise<string> {
    const file = asObject(
      asObject(
        await this.backend.request('instruction_file_get', {
          fileId: 'soul'
        })
      )?.file
    )
    if (!file || file.id !== 'soul' || typeof file.content !== 'string') {
      throw new Error('The backend returned an invalid SOUL.md document')
    }
    return file.content
  }

  async setSoul(value: unknown): Promise<string> {
    if (typeof value !== 'string' || value.length > 1_000_000) {
      throw new Error('Invalid SOUL.md document')
    }
    const file = asObject(
      asObject(
        await this.backend.request(
          'instruction_file_update',
          { fileId: 'soul', content: value },
          { timeout: 'none' }
        )
      )?.file
    )
    if (!file || file.id !== 'soul' || file.content !== value) {
      throw new Error('The backend returned an invalid SOUL.md document')
    }
    return value
  }

  async listMemories(value: unknown): Promise<readonly MemoryRecord[]> {
    if (value !== undefined && typeof value !== 'string') {
      throw new Error('Invalid memory search')
    }
    const query = typeof value === 'string' ? value.trim() : ''
    const command = query ? 'memory_search' : 'memory_list'
    const response = asObject(
      await this.backend.request(command, {
        ...(query ? { query } : {}),
        limit: 100
      })
    )
    if (!response || !Array.isArray(response.memories)) {
      throw new Error('The backend returned an invalid memory list')
    }
    return response.memories.map(parseMemory)
  }

  async createMemory(value: unknown): Promise<MemoryRecord> {
    const input = parseMemoryInput(value)
    return parseMemoryResponse(
      await this.backend.request(
        'memory_create',
        { content: input.content, category: input.category },
        { timeout: 'none' }
      )
    )
  }

  async updateMemory(memoryIdValue: unknown, value: unknown): Promise<MemoryRecord> {
    const memoryId = nonEmptyIdentifier(memoryIdValue, 'memory identifier')
    const input = parseMemoryInput(value)
    return parseMemoryResponse(
      await this.backend.request('memory_update', { memoryId, patch: input }, { timeout: 'none' })
    )
  }

  async deleteMemory(memoryIdValue: unknown): Promise<void> {
    const memoryId = nonEmptyIdentifier(memoryIdValue, 'memory identifier')
    await this.backend.request('memory_delete', { memoryId }, { timeout: 'none' })
  }
}
