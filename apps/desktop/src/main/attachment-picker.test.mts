import assert from 'node:assert/strict'
import test from 'node:test'

import { attachmentDialogProperties, pickAttachments } from './attachment-picker.mts'

test('attachment dialog kinds map to platform-valid Electron properties', () => {
  assert.deepEqual(attachmentDialogProperties('files'), ['openFile', 'multiSelections'])
  assert.deepEqual(attachmentDialogProperties('folders'), ['openDirectory', 'multiSelections'])
  assert.deepEqual(attachmentDialogProperties('files-or-folders'), [
    'openFile',
    'openDirectory',
    'multiSelections'
  ])
})

test('attachment picker describes selected files and folders in dialog order', async () => {
  const inspectedPaths: string[] = []
  const attachments = await pickAttachments({
    chooseDialogKind: async () => {
      throw new Error('macOS should use its combined picker')
    },
    inspectDirectory: async (path) => {
      inspectedPaths.push(path)
      return path.endsWith('/project')
    },
    platform: 'darwin',
    showDialog: async (kind) => {
      assert.equal(kind, 'files-or-folders')
      return {
        canceled: false,
        filePaths: ['/tmp/notes.txt', '/tmp/project', '/tmp/notes.txt']
      }
    }
  })

  assert.deepEqual(attachments, [
    { kind: 'file', name: 'notes.txt', path: '/tmp/notes.txt' },
    { kind: 'folder', name: 'project', path: '/tmp/project' }
  ])
  assert.deepEqual(inspectedPaths, ['/tmp/notes.txt', '/tmp/project'])
})

test('attachment picker returns no attachments without inspecting paths when cancelled', async () => {
  let inspectionCount = 0
  const attachments = await pickAttachments({
    chooseDialogKind: async () => {
      throw new Error('macOS should use its combined picker')
    },
    inspectDirectory: async () => {
      inspectionCount += 1
      return false
    },
    platform: 'darwin',
    showDialog: async (kind) => {
      assert.equal(kind, 'files-or-folders')
      return { canceled: true, filePaths: ['/tmp/ignored.txt'] }
    }
  })

  assert.deepEqual(attachments, [])
  assert.equal(inspectionCount, 0)
})

test('attachment picker opens separate file and folder dialogs off macOS', async () => {
  const openedKinds: string[] = []
  const run = (
    platform: NodeJS.Platform,
    selectedKind: 'files' | 'folders'
  ): ReturnType<typeof pickAttachments> =>
    pickAttachments({
      chooseDialogKind: async () => selectedKind,
      inspectDirectory: async () => selectedKind === 'folders',
      platform,
      showDialog: async (kind) => {
        openedKinds.push(kind)
        return {
          canceled: false,
          filePaths: [selectedKind === 'files' ? 'C:\\notes.txt' : '/tmp/project']
        }
      }
    })

  const [files, folders] = await Promise.all([run('win32', 'files'), run('linux', 'folders')])

  assert.deepEqual(openedKinds.toSorted(), ['files', 'folders'])
  assert.equal(files[0].kind, 'file')
  assert.equal(folders[0].kind, 'folder')
})

test('attachment picker stops when the separate file-or-folder choice is cancelled', async () => {
  let dialogCount = 0
  const attachments = await pickAttachments({
    chooseDialogKind: async () => undefined,
    inspectDirectory: async () => false,
    platform: 'linux',
    showDialog: async () => {
      dialogCount += 1
      return { canceled: false, filePaths: ['/tmp/ignored.txt'] }
    }
  })

  assert.deepEqual(attachments, [])
  assert.equal(dialogCount, 0)
})
