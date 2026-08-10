import {
  attachmentsPickChannel,
  type AttachmentApi,
  type ComposerAttachment
} from '../shared/attachment-api.ts'

export interface AttachmentIpcRenderer {
  invoke(channel: string): Promise<unknown>
}

export function createAttachmentApi(ipcRenderer: AttachmentIpcRenderer): AttachmentApi {
  return {
    pick: () => ipcRenderer.invoke(attachmentsPickChannel) as Promise<readonly ComposerAttachment[]>
  }
}
