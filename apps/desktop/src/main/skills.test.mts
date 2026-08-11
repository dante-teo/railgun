import assert from 'node:assert/strict'
import test from 'node:test'

import { SkillService, validateSkillName, type SkillBackend } from './skills.mts'

test('skill service maps automatic invocation and validates names', async () => {
  const backend: SkillBackend = {
    request: async () => ({
      skills: [
        { name: 'release-review', description: 'Review releases', disableModelInvocation: true }
      ]
    })
  }
  assert.deepEqual(await new SkillService(backend).list(), [
    {
      name: 'release-review',
      description: 'Review releases',
      allowModelInvocation: false
    }
  ])
  assert.throws(() => validateSkillName('Uppercase'), /\[a-z0-9-\]/)
})
