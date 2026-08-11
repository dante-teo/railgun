import {
  skillsCreateChannel,
  skillsDeleteChannel,
  skillsGetChannel,
  skillsListChannel,
  skillsUpdateChannel,
  type ManagedSkill,
  type SkillApi,
  type SkillSummary
} from '../shared/skill-api.ts'

export interface SkillIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function createSkillApi(ipcRenderer: SkillIpcRenderer): SkillApi {
  return {
    list: () => ipcRenderer.invoke(skillsListChannel) as Promise<readonly SkillSummary[]>,
    get: (name) => ipcRenderer.invoke(skillsGetChannel, name) as Promise<ManagedSkill>,
    create: (input) => ipcRenderer.invoke(skillsCreateChannel, input) as Promise<ManagedSkill>,
    update: (name, input) =>
      ipcRenderer.invoke(skillsUpdateChannel, name, input) as Promise<ManagedSkill>,
    delete: async (name) => {
      await ipcRenderer.invoke(skillsDeleteChannel, name)
    }
  }
}
