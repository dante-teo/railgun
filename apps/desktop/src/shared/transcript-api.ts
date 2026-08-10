import type { ComposerAttachment } from './attachment-api'

export const transcriptSnapshotChannel = 'railgun:transcript:snapshot'
export const transcriptUpdateChannel = 'railgun:transcript:update'
export const transcriptSendChannel = 'railgun:transcript:send'
export const transcriptAbortChannel = 'railgun:transcript:abort'
export const transcriptApprovalResponseChannel = 'railgun:transcript:approval-response'
export const transcriptClarificationResponseChannel = 'railgun:transcript:clarification-response'

export const maximumTranscriptPromptLength = 100_000
export const maximumClarificationAnswerLength = 100_000
export const declinedClarificationAnswer = '[user declined to answer]'

export type TranscriptStatus = 'idle' | 'loading' | 'ready' | 'running' | 'error'

export interface TranscriptUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly text: string
}

export interface TranscriptAssistantMessage {
  readonly id: string
  readonly role: 'assistant'
  readonly text: string
  readonly status: 'streaming' | 'complete' | 'failed'
}

export interface TranscriptToolMessage {
  readonly id: string
  readonly role: 'tool'
  readonly name: string
  readonly target?: string
  readonly failed: boolean
}

interface TranscriptInteractionBase {
  readonly id: string
  readonly status: 'pending' | 'responding'
  readonly error: string | null
}

export interface TranscriptApprovalRequest extends TranscriptInteractionBase {
  readonly type: 'approval'
  readonly command: string
}

export interface TranscriptClarificationRequest extends TranscriptInteractionBase {
  readonly type: 'clarification'
  readonly question: string
  readonly choices: readonly string[]
}

export type TranscriptInteractionRequest =
  TranscriptApprovalRequest | TranscriptClarificationRequest

export type TranscriptMessage =
  TranscriptUserMessage | TranscriptAssistantMessage | TranscriptToolMessage

export interface TranscriptSnapshot {
  readonly revision: number
  readonly sessionId: string | null
  readonly status: TranscriptStatus
  readonly messages: readonly TranscriptMessage[]
  readonly interactions: readonly TranscriptInteractionRequest[]
  readonly error: string | null
}

export interface TranscriptUpdate {
  readonly revision: number
  readonly snapshot: TranscriptSnapshot
}

export interface TranscriptSubmission {
  readonly text: string
  readonly attachments: readonly ComposerAttachment[]
}

export interface TranscriptApi {
  getSnapshot: () => Promise<TranscriptSnapshot>
  subscribe: (listener: (update: TranscriptUpdate) => void) => () => void
  send: (sessionId: string, submission: TranscriptSubmission) => Promise<void>
  abort: (sessionId: string) => Promise<void>
  respondToApproval: (sessionId: string, requestId: string, approved: boolean) => Promise<void>
  respondToClarification: (sessionId: string, requestId: string, answer: string) => Promise<void>
}

export function emptyTranscriptSnapshot(): TranscriptSnapshot {
  return {
    revision: 0,
    sessionId: null,
    status: 'idle',
    messages: [],
    interactions: [],
    error: null
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function isAbsoluteAttachmentPath(value: string): boolean {
  return (
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  )
}

function attachmentLine(value: unknown): string {
  if (!value || typeof value !== 'object') {
    throw new Error('An attachment is invalid')
  }
  const attachment = value as Partial<ComposerAttachment>
  if (
    (attachment.kind !== 'file' && attachment.kind !== 'folder') ||
    typeof attachment.path !== 'string' ||
    attachment.path !== attachment.path.trim() ||
    !attachment.path ||
    attachment.path.length > 32_768 ||
    containsControlCharacter(attachment.path) ||
    !isAbsoluteAttachmentPath(attachment.path)
  ) {
    throw new Error('An attachment is invalid')
  }
  return `- ${attachment.kind}: ${attachment.path}`
}

export function projectTranscriptPrompt(submissionValue: unknown): string {
  if (
    !submissionValue ||
    typeof submissionValue !== 'object' ||
    typeof (submissionValue as Partial<TranscriptSubmission>).text !== 'string' ||
    !Array.isArray((submissionValue as Partial<TranscriptSubmission>).attachments)
  ) {
    throw new Error('The message is invalid')
  }

  const submission = submissionValue as TranscriptSubmission

  const draft = submission.text.trim()
  const attachmentLines = submission.attachments.map(attachmentLine)
  if (!draft && attachmentLines.length === 0) {
    throw new Error('Enter a message or attach a file or folder')
  }

  const attachments =
    attachmentLines.length > 0 ? `Attachments:\n${attachmentLines.join('\n')}` : ''
  const prompt = [draft, attachments].filter(Boolean).join('\n\n')
  if (prompt.length > maximumTranscriptPromptLength) {
    throw new Error('The final message exceeds the 100,000 character limit')
  }
  return prompt
}
