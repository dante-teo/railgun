import assert from 'node:assert/strict'
import test from 'node:test'

import { SkillService, validateSkillName, type SkillBackend } from './skills.mts'

test('skill service maps automatic invocation and validates names', async () => {
  const handAuthoredDescription = 'D'.repeat(579)
  const backend: SkillBackend = {
    request: async () => ({
      skills: [
        { name: 'release-review', description: 'Review releases', disableModelInvocation: true },
        {
          name: 'diagram-design',
          description: handAuthoredDescription,
          disableModelInvocation: false
        }
      ]
    })
  }
  assert.deepEqual(await new SkillService(backend).list(), [
    {
      name: 'release-review',
      description: 'Review releases',
      allowModelInvocation: false
    },
    {
      name: 'diagram-design',
      description: handAuthoredDescription,
      allowModelInvocation: true
    }
  ])
  assert.throws(() => validateSkillName('Uppercase'), /\[a-z0-9-\]/)
})
