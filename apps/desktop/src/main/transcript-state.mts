import type {
  TranscriptFileChange,
  TranscriptInteractionRequest,
  TranscriptMessage,
  TranscriptSnapshot,
  TranscriptToolMessage
} from '../shared/transcript-api.ts'
import { maximumClarificationAnswerLength } from '../shared/transcript-api.ts'
import { asObject } from './value-validation.mts'

const transcriptPageLimit = 100
const maximumTranscriptEntries = 2_000
const maximumMessageTextLength = 100_000
const maximumToolIdLength = 512
const maximumToolNameLength = 128
const maximumToolTargetLength = 256
const maximumToolDetailLength = 256
const maximumShellCommandLength = 4_096
const maximumShellOutputLength = 12_288
const maximumFileDiffBytes = 16_384
const maximumInteractionIdLength = 128
const maximumInteractionTextLength = 8_000
const maximumInteractionChoiceLength = 500
const maximumInteractionChoices = 32

export const transcriptLoadError = 'Could not load this transcript. Try reopening the task.'
export const transcriptSendError = 'Could not send the message. Try again.'

export type TranscriptAction =
  | { readonly type: 'load-started'; readonly sessionId: string }
  | {
      readonly type: 'loaded'
      readonly sessionId: string
      readonly messages: readonly TranscriptMessage[]
    }
  | { readonly type: 'load-failed'; readonly sessionId: string }
  | { readonly type: 'submitted'; readonly id: string; readonly text: string }
  | { readonly type: 'assistant-started'; readonly id: string }
  | { readonly type: 'assistant-updated'; readonly id: string; readonly delta: string }
  | { readonly type: 'assistant-ended'; readonly id: string }
  | { readonly type: 'tool-started'; readonly message: TranscriptToolMessage }
  | {
      readonly type: 'tool-updated'
      readonly id: string
      readonly name?: string
      readonly target?: string
      readonly detail?: string
      readonly command?: string
      readonly output?: string
      readonly fileChange?: TranscriptFileChange
      readonly failed?: boolean
      readonly running?: boolean
    }
  | { readonly type: 'interaction-received'; readonly request: TranscriptInteractionRequest }
  | { readonly type: 'interaction-response-started'; readonly id: string }
  | { readonly type: 'interaction-response-failed'; readonly id: string }
  | { readonly type: 'interaction-response-succeeded'; readonly id: string }
  | { readonly type: 'send-failed'; readonly messages: readonly TranscriptMessage[] }

export type NormalizedLiveFrame =
  | { readonly type: 'agent-started'; readonly runId?: string }
  | { readonly type: 'agent-ended'; readonly runId?: string }
  | { readonly type: 'assistant-started' }
  | { readonly type: 'assistant-delta'; readonly delta: string }
  | { readonly type: 'assistant-ended' }
  | {
      readonly type: 'tool-started'
      readonly toolCallId: string
      readonly name: string
      readonly target?: string
      readonly detail?: string
      readonly command?: string
    }
  | {
      readonly type: 'tool-ended'
      readonly toolCallId: string
      readonly name: string
      readonly failed: boolean
      readonly output?: string
      readonly fileChange?: TranscriptFileChange
    }
  | { readonly type: 'interaction-requested'; readonly request: TranscriptInteractionRequest }

type NormalizedToolStartedFrame = Extract<NormalizedLiveFrame, { readonly type: 'tool-started' }>

type TranscriptPage = {
  readonly messages: readonly TranscriptMessage[]
  readonly nextCursor?: number
}

type TranscriptPageRequest = (fields: Record<string, unknown>) => Promise<unknown>

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}

function boundedText(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? bounded(value, limit) : undefined
}

function boundedUtf8(
  value: string,
  limit: number
): { readonly text: string; readonly truncated: boolean } {
  const encoder = new TextEncoder()
  const encoded = encoder.encode(value)
  if (encoded.length <= limit) {
    return { text: value, truncated: false }
  }
  const budget = Math.max(0, limit - encoder.encode('…').length)
  const firstExcludedByte = encoded[budget]
  const boundary =
    firstExcludedByte !== undefined && (firstExcludedByte & 0b1100_0000) === 0b1000_0000
      ? Array.from(encoded.subarray(0, budget)).findLastIndex(
          (byte) => (byte & 0b1100_0000) !== 0b1000_0000
        )
      : budget
  const prefix = new TextDecoder().decode(encoded.subarray(0, Math.max(0, boundary)))
  return { text: `${prefix}…`, truncated: true }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function requiredText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const text = bounded(value.trim(), limit)
  return text || undefined
}

function strictRequiredText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.length > limit) {
    return undefined
  }
  const text = value.trim()
  return text && !containsControlCharacter(text) ? text : undefined
}

function positiveSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function optionalTimestamp(value: unknown): number | undefined {
  return value === undefined ? undefined : nonNegativeSafeInteger(value)
}

function safeBasename(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const target = strictRequiredText(
    value.replaceAll('\\', '/').split('/').filter(Boolean).at(-1),
    maximumToolTargetLength
  )
  return target && target !== '.' && target !== '..' ? target : undefined
}

function isFileTool(name: string): boolean {
  return (
    name === 'read_file' ||
    name === 'create_file' ||
    name === 'write_file' ||
    name === 'delete_file' ||
    name === 'list_directory'
  )
}

function safeToolTarget(name: string, argumentsValue: unknown): string | undefined {
  return isFileTool(name) ? safeBasename(asObject(argumentsValue)?.path) : undefined
}

function countLabel(value: unknown, singular: string, plural: string): string | undefined {
  return Array.isArray(value)
    ? `${value.length} ${value.length === 1 ? singular : plural}`
    : undefined
}

function mappedDetail(
  value: unknown,
  labels: Readonly<Record<string, string>>
): string | undefined {
  return typeof value === 'string' ? labels[value] : undefined
}

const memoryDetails: Readonly<Record<string, string>> = {
  preference: 'Preference memory',
  fact: 'Fact memory',
  project: 'Project memory'
}

const scheduleDetails: Readonly<Record<string, string>> = {
  list: 'Scheduled tasks',
  add: 'Add scheduled task',
  update: 'Update scheduled task',
  remove: 'Remove scheduled task'
}

const inspectionDetails: Readonly<Record<string, string>> = {
  config: 'Configuration diagnostics',
  sessions: 'Session diagnostics',
  memories: 'Memory diagnostics',
  cron: 'Schedule diagnostics',
  paths: 'Path diagnostics'
}

function safeToolDetail(name: string, argumentsValue: unknown): string | undefined {
  const fields = asObject(argumentsValue)
  const detail = (() => {
    switch (name) {
      case 'read_file':
      case 'create_file':
      case 'write_file':
      case 'delete_file':
      case 'list_directory':
        return safeBasename(fields?.path)
      case 'run_shell_command':
        return 'Local shell command'
      case 'todo':
        return countLabel(fields?.todos, 'task item', 'task items') ?? 'Current task list'
      case 'clarify':
        return 'User clarification request'
      case 'memory_write':
        return mappedDetail(fields?.category, memoryDetails)
      case 'memory_search':
        return 'Saved memories'
      case 'memory_consolidate':
        return countLabel(fields?.operations, 'memory operation', 'memory operations')
      case 'cron':
        return mappedDetail(fields?.action, scheduleDetails)
      case 'railgun_inspect':
        return mappedDetail(fields?.area, inspectionDetails)
      case 'skill_view': {
        const skill = strictRequiredText(fields?.name, maximumToolDetailLength)
        return skill ? `Skill: ${skill}` : undefined
      }
      case 'web_search':
        return 'Public web search'
      case 'web_fetch':
        return 'Public web page'
      case 'delegate_task':
        return countLabel(fields?.goals, 'delegated task', 'delegated tasks')
      default:
        return undefined
    }
  })()
  return detail ? bounded(detail, maximumToolDetailLength) : undefined
}

const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

function stripUnsafeTerminalControls(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint === 9 || codePoint === 10 || (codePoint >= 32 && codePoint !== 127)
    })
    .join('')
}

function safeTerminalText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const text = stripUnsafeTerminalControls(
    value.replace(ansiEscapePattern, '').replaceAll(/\r\n?/g, '\n')
  ).trim()
  return text ? bounded(text, limit) : undefined
}

function safeShellCommand(name: string, argumentsValue: unknown): string | undefined {
  return name === 'run_shell_command'
    ? safeTerminalText(asObject(argumentsValue)?.command, maximumShellCommandLength)
    : undefined
}

function hasBasenameOnlyDiffHeaders(diff: string): boolean {
  if (!diff) {
    return true
  }
  const [beforeHeader, afterHeader] = diff.split('\n', 3)
  const before = beforeHeader?.startsWith('--- ') ? beforeHeader.slice(4) : undefined
  const after = afterHeader?.startsWith('+++ ') ? afterHeader.slice(4) : undefined
  return Boolean(before && before === after && safeBasename(before) === before)
}

function safeFileChange(
  value: unknown,
  name: string,
  failed: boolean
): TranscriptFileChange | undefined {
  if (failed || (name !== 'create_file' && name !== 'write_file')) {
    return undefined
  }
  const fields = asObject(value)
  if (fields?.status === 'changed') {
    if (
      typeof fields.diff !== 'string' ||
      typeof fields.truncated !== 'boolean' ||
      (fields.diff === '' && name !== 'create_file') ||
      !hasBasenameOnlyDiffHeaders(fields.diff)
    ) {
      return undefined
    }
    const diff = boundedUtf8(fields.diff, maximumFileDiffBytes)
    return {
      status: 'changed',
      diff: diff.text,
      truncated: fields.truncated || diff.truncated
    }
  }
  if (
    (fields?.status === 'unchanged' || fields?.status === 'unavailable') &&
    fields.diff === undefined &&
    fields.truncated === undefined
  ) {
    return { status: fields.status }
  }
  return undefined
}

function copyFileChange(fileChange: TranscriptFileChange): TranscriptFileChange {
  return { ...fileChange }
}

function normalizedToolStartedFrame(
  toolCallId: string,
  name: string,
  argumentsValue: unknown
): NormalizedToolStartedFrame {
  const target = safeToolTarget(name, argumentsValue)
  const detail = safeToolDetail(name, argumentsValue)
  const command = safeShellCommand(name, argumentsValue)
  return {
    type: 'tool-started',
    toolCallId,
    name,
    ...(target ? { target } : {}),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {})
  }
}

function copyMessage(message: TranscriptMessage): TranscriptMessage {
  return message.role === 'tool' && message.fileChange
    ? { ...message, fileChange: copyFileChange(message.fileChange) }
    : { ...message }
}

function copyInteraction(request: TranscriptInteractionRequest): TranscriptInteractionRequest {
  return request.type === 'clarification'
    ? { ...request, choices: [...request.choices] }
    : { ...request }
}

export function copyTranscriptSnapshot(snapshot: TranscriptSnapshot): TranscriptSnapshot {
  return {
    ...snapshot,
    messages: snapshot.messages.map(copyMessage),
    interactions: snapshot.interactions.map(copyInteraction)
  }
}

function parseConversationMessage(
  fields: Record<string, unknown>,
  ordinal: number
): TranscriptMessage | undefined {
  if (fields.role !== 'user' && fields.role !== 'assistant') {
    return undefined
  }
  const messageId =
    fields.messageId === undefined ? undefined : positiveSafeInteger(fields.messageId)
  const text =
    typeof fields.text === 'string' && fields.text.length <= maximumMessageTextLength
      ? fields.text
      : undefined
  if ((fields.messageId !== undefined && messageId === undefined) || !text?.trim()) {
    return undefined
  }
  const id = messageId === undefined ? `restored-message-${ordinal}` : `message-${messageId}`
  const timestamp = optionalTimestamp(
    fields.role === 'user' ? fields.startedAt : fields.completedAt
  )
  if (
    (fields.role === 'user' && fields.startedAt !== undefined && timestamp === undefined) ||
    (fields.role === 'assistant' && fields.completedAt !== undefined && timestamp === undefined)
  ) {
    return undefined
  }
  return fields.role === 'user'
    ? { id, role: 'user', text, ...(timestamp === undefined ? {} : { startedAt: timestamp }) }
    : {
        id,
        role: 'assistant',
        text,
        status: 'complete',
        ...(timestamp === undefined ? {} : { completedAt: timestamp })
      }
}

function parseToolMessage(fields: Record<string, unknown>): TranscriptToolMessage | undefined {
  if (fields.role !== 'tool') {
    return undefined
  }
  const id = strictRequiredText(fields.id, maximumToolIdLength)
  const name = strictRequiredText(fields.name, maximumToolNameLength)
  const target = fields.target === undefined ? undefined : safeBasename(fields.target)
  const detail =
    fields.detail === undefined
      ? undefined
      : strictRequiredText(fields.detail, maximumToolDetailLength)
  const command =
    fields.command === undefined
      ? undefined
      : safeTerminalText(fields.command, maximumShellCommandLength)
  const output =
    fields.output === undefined
      ? undefined
      : safeTerminalText(fields.output, maximumShellOutputLength)
  const fileChange =
    fields.fileChange === undefined
      ? undefined
      : safeFileChange(fields.fileChange, name ?? '', fields.failed === true)
  if (
    !id ||
    !name ||
    typeof fields.failed !== 'boolean' ||
    (fields.target !== undefined && !target) ||
    (fields.detail !== undefined && !detail) ||
    (fields.command !== undefined && !command) ||
    (fields.output !== undefined && !output) ||
    (fields.fileChange !== undefined && !fileChange) ||
    (name !== 'run_shell_command' && (command !== undefined || output !== undefined))
  ) {
    return undefined
  }
  return {
    id,
    role: 'tool',
    name,
    ...(target ? { target } : {}),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(output ? { output } : {}),
    ...(fileChange ? { fileChange } : {}),
    failed: fields.failed
  }
}

function parsePersistedMessage(value: unknown, ordinal: number): TranscriptMessage | undefined {
  const fields = asObject(value)
  return fields
    ? (parseConversationMessage(fields, ordinal) ?? parseToolMessage(fields))
    : undefined
}

function parseTranscriptPage(value: unknown, sessionId: string, cursor: number): TranscriptPage {
  const fields = asObject(value)
  if (
    fields?.sessionId !== sessionId ||
    !Array.isArray(fields.messages) ||
    fields.messages.length > transcriptPageLimit
  ) {
    throw new Error('Invalid transcript page')
  }
  const messages = fields.messages.map((message, index) =>
    parsePersistedMessage(message, cursor + index)
  )
  if (!messages.every((message): message is TranscriptMessage => message !== undefined)) {
    throw new Error('Invalid transcript page')
  }
  if (fields.nextCursor === undefined) {
    return { messages }
  }
  const nextCursor = nonNegativeSafeInteger(fields.nextCursor)
  if (nextCursor === undefined || nextCursor <= cursor || messages.length === 0) {
    throw new Error('Invalid transcript page')
  }
  return { messages, nextCursor }
}

function hasUniqueMessageIds(messages: readonly TranscriptMessage[]): boolean {
  return new Set(messages.map(({ id }) => id)).size === messages.length
}

export async function hydrateTranscript(
  requestPage: TranscriptPageRequest,
  sessionId: string
): Promise<readonly TranscriptMessage[]> {
  const collect = async (
    cursor: number,
    messages: readonly TranscriptMessage[]
  ): Promise<readonly TranscriptMessage[]> => {
    const page = parseTranscriptPage(
      await requestPage({ sessionId, cursor, limit: transcriptPageLimit }),
      sessionId,
      cursor
    )
    const nextMessages = [...messages, ...page.messages]
    if (nextMessages.length > maximumTranscriptEntries) {
      throw new Error('Transcript pagination exceeded its limit')
    }
    if (page.nextCursor !== undefined) {
      return collect(page.nextCursor, nextMessages)
    }
    if (!hasUniqueMessageIds(nextMessages)) {
      throw new Error('Invalid transcript page')
    }
    return nextMessages
  }

  return collect(0, [])
}

function optionalRunId(value: unknown): string | undefined {
  return requiredText(value, maximumToolIdLength)
}

function normalizeToolExecutionFrame(
  frame: Record<string, unknown>
): NormalizedLiveFrame | undefined {
  const toolCallId = requiredText(frame.toolCallId, maximumToolIdLength)
  if (!toolCallId) {
    return undefined
  }
  if (frame.type === 'tool_execution_start') {
    const name = requiredText(frame.toolName, maximumToolNameLength)
    if (!name) {
      return undefined
    }
    return normalizedToolStartedFrame(toolCallId, name, frame.args)
  }
  const result = asObject(frame.result)
  const name = requiredText(frame.toolName, maximumToolNameLength)
  const failed = result?.isError
  if (!name || typeof failed !== 'boolean') {
    return undefined
  }
  const output =
    name === 'run_shell_command'
      ? safeTerminalText(result?.content, maximumShellOutputLength)
      : undefined
  const fileChange =
    result?.fileChange === undefined ? undefined : safeFileChange(result.fileChange, name, failed)
  return result?.fileChange !== undefined && !fileChange
    ? undefined
    : {
        type: 'tool-ended',
        toolCallId,
        name,
        failed,
        ...(output ? { output } : {}),
        ...(fileChange ? { fileChange } : {})
      }
}

function normalizeMessageUpdate(frame: Record<string, unknown>): NormalizedLiveFrame | undefined {
  const event = asObject(frame.streamEvent)
  if (!event || typeof event.type !== 'string') {
    return undefined
  }
  if (event.type === 'text_delta') {
    const delta = boundedText(event.delta, maximumMessageTextLength)
    return delta ? { type: 'assistant-delta', delta } : undefined
  }
  if (event.type !== 'toolcall_start' && event.type !== 'toolcall_end') {
    return undefined
  }
  const toolCallId = requiredText(event.id, maximumToolIdLength)
  const name = requiredText(event.name, maximumToolNameLength)
  if (!toolCallId || !name) {
    return undefined
  }
  return normalizedToolStartedFrame(
    toolCallId,
    name,
    event.type === 'toolcall_end' ? event.arguments : undefined
  )
}

function normalizeInteractionRequest(
  frame: Record<string, unknown>
): NormalizedLiveFrame | undefined {
  const id = strictRequiredText(frame.requestId, maximumInteractionIdLength)
  if (!id) {
    return undefined
  }
  if (frame.type === 'approval_request') {
    const command = requiredText(frame.command, maximumInteractionTextLength)
    return command
      ? {
          type: 'interaction-requested',
          request: { id, type: 'approval', command, status: 'pending', error: null }
        }
      : undefined
  }

  const question = requiredText(frame.question, maximumInteractionTextLength)
  const rawChoices = frame.choices
  if (
    !question ||
    (rawChoices !== undefined &&
      (!Array.isArray(rawChoices) ||
        rawChoices.length === 0 ||
        rawChoices.length > maximumInteractionChoices))
  ) {
    return undefined
  }
  const choices = Array.isArray(rawChoices)
    ? rawChoices.map((choice) => requiredText(choice, maximumInteractionChoiceLength))
    : []
  return choices.every((choice): choice is string => choice !== undefined)
    ? {
        type: 'interaction-requested',
        request: { id, type: 'clarification', question, choices, status: 'pending', error: null }
      }
    : undefined
}

export function validateClarificationAnswer(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Enter a valid response before submitting.')
  }
  const answer = value.trim()
  if (!answer || answer.length > maximumClarificationAnswerLength) {
    throw new Error('Enter a valid response before submitting.')
  }
  return answer
}

export function normalizeTranscriptFrame(value: unknown): NormalizedLiveFrame | undefined {
  const frame = asObject(value)
  if (!frame || typeof frame.type !== 'string') {
    return undefined
  }
  switch (frame.type) {
    case 'agent_start':
      return { type: 'agent-started', runId: optionalRunId(frame.runId) }
    case 'agent_end':
      return { type: 'agent-ended', runId: optionalRunId(frame.runId) }
    case 'message_start':
      return asObject(frame.message)?.role === 'assistant'
        ? { type: 'assistant-started' }
        : undefined
    case 'message_end':
      return asObject(frame.message)?.role === 'assistant' ? { type: 'assistant-ended' } : undefined
    case 'tool_execution_start':
    case 'tool_execution_end':
      return normalizeToolExecutionFrame(frame)
    case 'message_update':
      return normalizeMessageUpdate(frame)
    case 'approval_request':
    case 'clarification_request':
      return normalizeInteractionRequest(frame)
    default:
      return undefined
  }
}

function updateMessage(
  messages: readonly TranscriptMessage[],
  id: string,
  update: (message: TranscriptMessage) => TranscriptMessage
): readonly TranscriptMessage[] {
  const index = messages.findIndex((message) => message.id === id)
  return index < 0
    ? messages
    : messages.map((message, messageIndex) => (messageIndex === index ? update(message) : message))
}

export function reduceTranscriptSnapshot(
  state: TranscriptSnapshot,
  action: TranscriptAction
): TranscriptSnapshot {
  switch (action.type) {
    case 'load-started':
      return {
        ...state,
        sessionId: action.sessionId,
        status: 'loading',
        messages: [],
        interactions: [],
        error: null
      }
    case 'loaded':
      return {
        ...state,
        sessionId: action.sessionId,
        status: 'ready',
        messages: action.messages.map(copyMessage),
        interactions: [],
        error: null
      }
    case 'load-failed':
      return {
        ...state,
        sessionId: action.sessionId,
        status: 'error',
        messages: [],
        interactions: [],
        error: transcriptLoadError
      }
    case 'submitted':
      return {
        ...state,
        status: 'running',
        messages: [...state.messages, { id: action.id, role: 'user', text: action.text }],
        interactions: [],
        error: null
      }
    case 'assistant-started':
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: action.id, role: 'assistant', text: '', status: 'streaming' }
        ]
      }
    case 'assistant-updated':
      return {
        ...state,
        messages: updateMessage(state.messages, action.id, (message) =>
          message.role === 'assistant'
            ? {
                ...message,
                text: bounded(`${message.text}${action.delta}`, maximumMessageTextLength)
              }
            : message
        )
      }
    case 'assistant-ended':
      return {
        ...state,
        messages: state.messages.flatMap((message) =>
          message.id !== action.id || message.role !== 'assistant'
            ? [message]
            : message.text.trim()
              ? [{ ...message, status: 'complete' }]
              : []
        )
      }
    case 'tool-started':
      return { ...state, messages: [...state.messages, copyMessage(action.message)] }
    case 'tool-updated':
      return {
        ...state,
        messages: updateMessage(state.messages, action.id, (message) =>
          message.role === 'tool'
            ? {
                ...message,
                ...(action.name ? { name: action.name } : {}),
                ...(action.target ? { target: action.target } : {}),
                ...(action.detail ? { detail: action.detail } : {}),
                ...(action.command ? { command: action.command } : {}),
                ...(action.output ? { output: action.output } : {}),
                ...(action.fileChange ? { fileChange: copyFileChange(action.fileChange) } : {}),
                ...(action.failed === undefined ? {} : { failed: action.failed }),
                ...(action.running === undefined ? {} : { running: action.running })
              }
            : message
        )
      }
    case 'interaction-received':
      return state.interactions.some(({ id }) => id === action.request.id)
        ? state
        : { ...state, interactions: [...state.interactions, copyInteraction(action.request)] }
    case 'interaction-response-started':
      return {
        ...state,
        interactions: state.interactions.map((request) =>
          request.id === action.id ? { ...request, status: 'responding', error: null } : request
        )
      }
    case 'interaction-response-failed':
      return {
        ...state,
        interactions: state.interactions.map((request) =>
          request.id === action.id
            ? {
                ...request,
                status: 'pending',
                error: 'The interaction response could not be completed.'
              }
            : request
        )
      }
    case 'interaction-response-succeeded':
      return {
        ...state,
        interactions: state.interactions.filter(({ id }) => id !== action.id)
      }
    case 'send-failed':
      return {
        ...state,
        status: 'ready',
        messages: action.messages.map(copyMessage),
        interactions: [],
        error: transcriptSendError
      }
  }
}
