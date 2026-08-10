export const attachmentsPickChannel = 'railgun:attachments:pick'

export type ComposerAttachmentKind = 'file' | 'folder'

export interface ComposerAttachment {
  readonly kind: ComposerAttachmentKind
  readonly name: string
  readonly path: string
}

export interface AttachmentApi {
  pick: () => Promise<readonly ComposerAttachment[]>
}
