import assert from 'node:assert/strict'
import test from 'node:test'

import { advisorGetChannel, advisorSetChannel } from '../shared/advisor-api.ts'
import {
  memoriesCreateChannel,
  memoriesDeleteChannel,
  memoriesListChannel,
  memoriesUpdateChannel,
  soulGetChannel,
  soulSetChannel
} from '../shared/personalization-api.ts'
import {
  schedulerGetStatusChannel,
  schedulerInstallChannel,
  schedulerUninstallChannel
} from '../shared/scheduler-api.ts'
import {
  skillsCreateChannel,
  skillsDeleteChannel,
  skillsGetChannel,
  skillsListChannel,
  skillsUpdateChannel
} from '../shared/skill-api.ts'
import { createAdvisorApi } from './advisor-api.mts'
import { createPersonalizationApi } from './personalization-api.mts'
import { createSchedulerApi } from './scheduler-api.mts'
import { createSkillApi } from './skill-api.mts'

test('settings preloads use only their narrow IPC channels', async () => {
  const calls: Array<readonly [string, ...unknown[]]> = []
  const ipc = {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push([channel, ...args])
      if (channel === soulGetChannel || channel === soulSetChannel) return '# Soul'
      if (channel === memoriesListChannel || channel === skillsListChannel) return []
      if (channel.startsWith('railgun:scheduler:')) return { state: 'running', detail: null }
      return { enabled: false, modelId: null }
    }
  }

  const advisor = createAdvisorApi(ipc)
  await advisor.get()
  await advisor.set({ enabled: false, modelId: null })
  const personalization = createPersonalizationApi(ipc)
  await personalization.soul.get()
  await personalization.soul.set('# Soul')
  await personalization.memories.list('query')
  await personalization.memories.create({ content: 'Memory', category: 'fact' })
  await personalization.memories.update('memory', { content: 'Updated', category: 'project' })
  await personalization.memories.delete('memory')
  const skills = createSkillApi(ipc)
  await skills.list()
  await skills.get('review')
  await skills.create({
    name: 'review',
    description: 'Review',
    body: '',
    allowModelInvocation: true
  })
  await skills.update('review', { description: 'Review', body: '', allowModelInvocation: false })
  await skills.delete('review')
  const scheduler = createSchedulerApi(ipc)
  await scheduler.getStatus()
  await scheduler.install()
  await scheduler.uninstall()

  assert.deepEqual(
    calls.map(([channel]) => channel),
    [
      advisorGetChannel,
      advisorSetChannel,
      soulGetChannel,
      soulSetChannel,
      memoriesListChannel,
      memoriesCreateChannel,
      memoriesUpdateChannel,
      memoriesDeleteChannel,
      skillsListChannel,
      skillsGetChannel,
      skillsCreateChannel,
      skillsUpdateChannel,
      skillsDeleteChannel,
      schedulerGetStatusChannel,
      schedulerInstallChannel,
      schedulerUninstallChannel
    ]
  )
})
