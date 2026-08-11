import assert from 'node:assert/strict'
import test from 'node:test'

import { PersonalizationService, type PersonalizationBackend } from './personalization.mts'

test('personalization validates SOUL and memory responses and bounds lists to 100', async () => {
  const calls: Array<{ command: string; fields?: Record<string, unknown> }> = []
  const backend: PersonalizationBackend = {
    request: async (command, fields) => {
      calls.push({ command, fields })
      if (command === 'instruction_file_get') return { file: { id: 'soul', content: '# Soul' } }
      return {
        memories: [{ id: 'memory', content: 'Remember this', category: 'project', createdAt: 1 }]
      }
    }
  }
  const service = new PersonalizationService(backend)
  assert.equal(await service.getSoul(), '# Soul')
  assert.equal((await service.listMemories(undefined))[0].category, 'project')
  assert.equal(calls[1].fields?.limit, 100)
})

test('personalization rejects unknown categories before calling the backend', async () => {
  let calls = 0
  const service = new PersonalizationService({
    request: async () => {
      calls += 1
      return undefined
    }
  })
  await assert.rejects(
    service.createMemory({ content: 'Memory', category: 'other' }),
    /Invalid memory/
  )
  assert.equal(calls, 0)
})
