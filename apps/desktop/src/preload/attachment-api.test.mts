import assert from 'node:assert/strict'
import test from 'node:test'

import { attachmentsPickChannel, type ComposerAttachment } from '../shared/attachment-api.ts'
import { createAttachmentApi } from './attachment-api.mts'

test('attachment preload invokes the picker and returns its selected paths', async () => {
  const expected: readonly ComposerAttachment[] = [
    { kind: 'folder', name: 'project', path: '/tmp/project' }
  ]
  const invokedChannels: string[] = []
  const api = createAttachmentApi({
    invoke: async (channel) => {
      invokedChannels.push(channel)
      return expected
    }
  })

  assert.deepEqual(await api.pick(), expected)
  assert.deepEqual(invokedChannels, [attachmentsPickChannel])
})
