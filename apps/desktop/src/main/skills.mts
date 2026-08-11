import type { ManagedSkill, SkillInput, SkillSummary } from '../shared/skill-api.ts'
import { asObject } from './value-validation.mts'

const skillNamePattern = /^[a-z0-9-]{1,64}$/
const maximumDescriptionLength = 500
const maximumBodyLength = 1_000_000

export interface SkillBackend {
  request(
    command: string,
    fields?: Record<string, unknown>,
    options?: { timeout?: 'default' | 'none' }
  ): Promise<unknown>
}

export function validateSkillName(value: unknown): string {
  if (typeof value !== 'string' || !skillNamePattern.test(value)) {
    throw new Error('Skill names must match [a-z0-9-]{1,64}')
  }
  return value
}

function parseSkillInput(value: unknown, nameValue?: unknown): SkillInput {
  const input = asObject(value)
  const name = validateSkillName(nameValue ?? input?.name)
  const description = input?.description
  const body = input?.body
  const allowModelInvocation = input?.allowModelInvocation
  if (
    typeof description !== 'string' ||
    !description.trim() ||
    description.length > maximumDescriptionLength ||
    typeof body !== 'string' ||
    body.length > maximumBodyLength ||
    typeof allowModelInvocation !== 'boolean'
  ) {
    throw new Error('Invalid skill')
  }
  return { name, description: description.trim(), body, allowModelInvocation }
}

function parseSkill(value: unknown, includeBody: boolean): SkillSummary | ManagedSkill {
  const skill = asObject(value)
  const name = validateSkillName(skill?.name)
  const description = skill?.description
  const disabled = skill?.disableModelInvocation
  if (
    typeof description !== 'string' ||
    !description.trim() ||
    description.length > maximumDescriptionLength ||
    typeof disabled !== 'boolean'
  ) {
    throw new Error('The backend returned an invalid skill')
  }
  const summary = { name, description, allowModelInvocation: !disabled }
  if (!includeBody) {
    return summary
  }
  if (typeof skill?.body !== 'string' || skill.body.length > maximumBodyLength) {
    throw new Error('The backend returned an invalid skill')
  }
  return { ...summary, body: skill.body }
}

function skillFields(input: SkillInput): Record<string, unknown> {
  return {
    name: input.name,
    description: input.description,
    body: input.body,
    disableModelInvocation: !input.allowModelInvocation
  }
}

export class SkillService {
  private readonly backend: SkillBackend

  constructor(backend: SkillBackend) {
    this.backend = backend
  }

  async list(): Promise<readonly SkillSummary[]> {
    const response = asObject(await this.backend.request('skills_list'))
    if (!response || !Array.isArray(response.skills)) {
      throw new Error('The backend returned an invalid skill list')
    }
    return response.skills.map((skill) => parseSkill(skill, false) as SkillSummary)
  }

  async get(nameValue: unknown): Promise<ManagedSkill> {
    const name = validateSkillName(nameValue)
    const response = asObject(await this.backend.request('skill_get', { name }))
    if (!response?.skill) {
      throw new Error('The backend returned an invalid skill')
    }
    return parseSkill(response.skill, true) as ManagedSkill
  }

  async create(value: unknown): Promise<ManagedSkill> {
    const input = parseSkillInput(value)
    const response = asObject(
      await this.backend.request('skill_create', skillFields(input), { timeout: 'none' })
    )
    if (!response?.skill) {
      throw new Error('The backend returned an invalid skill')
    }
    return parseSkill(response.skill, true) as ManagedSkill
  }

  async update(nameValue: unknown, value: unknown): Promise<ManagedSkill> {
    const input = parseSkillInput(value, nameValue)
    const response = asObject(
      await this.backend.request('skill_update', skillFields(input), { timeout: 'none' })
    )
    if (!response?.skill) {
      throw new Error('The backend returned an invalid skill')
    }
    return parseSkill(response.skill, true) as ManagedSkill
  }

  async delete(nameValue: unknown): Promise<void> {
    await this.backend.request(
      'skill_delete',
      { name: validateSkillName(nameValue) },
      { timeout: 'none' }
    )
  }
}
