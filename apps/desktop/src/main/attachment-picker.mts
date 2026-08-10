import { basename } from 'node:path'

import type { ComposerAttachment } from '../shared/attachment-api.ts'

export type AttachmentDialogKind = 'files' | 'folders' | 'files-or-folders'
export type SeparateAttachmentDialogKind = Exclude<AttachmentDialogKind, 'files-or-folders'>
type AttachmentDialogProperty = 'openFile' | 'openDirectory' | 'multiSelections'

const attachmentDialogPropertyMap: Readonly<
  Record<AttachmentDialogKind, readonly AttachmentDialogProperty[]>
> = {
  files: ['openFile', 'multiSelections'],
  folders: ['openDirectory', 'multiSelections'],
  'files-or-folders': ['openFile', 'openDirectory', 'multiSelections']
}

interface AttachmentDialogResult {
  readonly canceled: boolean
  readonly filePaths: readonly string[]
}

interface AttachmentPickerDependencies {
  readonly chooseDialogKind: () => Promise<SeparateAttachmentDialogKind | undefined>
  readonly inspectDirectory: (path: string) => Promise<boolean>
  readonly platform: NodeJS.Platform
  readonly showDialog: (kind: AttachmentDialogKind) => Promise<AttachmentDialogResult>
}

export function attachmentDialogProperties(kind: AttachmentDialogKind): AttachmentDialogProperty[] {
  return [...attachmentDialogPropertyMap[kind]]
}

function describeAttachment(path: string, isDirectory: boolean): ComposerAttachment {
  return {
    kind: isDirectory ? 'folder' : 'file',
    name: basename(path) || path,
    path
  }
}

export async function pickAttachments({
  chooseDialogKind,
  inspectDirectory,
  platform,
  showDialog
}: AttachmentPickerDependencies): Promise<readonly ComposerAttachment[]> {
  const dialogKind = platform === 'darwin' ? 'files-or-folders' : await chooseDialogKind()
  if (!dialogKind) {
    return []
  }

  const result = await showDialog(dialogKind)
  if (result.canceled) {
    return []
  }

  return Promise.all(
    [...new Set(result.filePaths)].map(async (path) =>
      describeAttachment(path, await inspectDirectory(path))
    )
  )
}
