import type {
  TranscriptInteractionRequest,
  TranscriptMessage,
  TranscriptSnapshot,
  TranscriptUpdate
} from '../shared/transcript-api.ts'
import { emptyTranscriptSnapshot, projectTranscriptPrompt } from '../shared/transcript-api.ts'
import {
  copyTranscriptSnapshot,
  hydrateTranscript,
  normalizeTranscriptFrame,
  reduceTranscriptSnapshot,
  transcriptLoadError,
  transcriptSendError,
  validateClarificationAnswer,
  type NormalizedLiveFrame,
  type TranscriptAction
} from './transcript-state.mts'
import { validateSessionId } from './tasks.mts'
import { asObject } from './value-validation.mts'

export { normalizeTranscriptFrame, reduceTranscriptSnapshot } from './transcript-state.mts'

const defaultStreamBroadcastIntervalMilliseconds = 50

type NormalizedToolStartedFrame = Extract<NormalizedLiveFrame, { readonly type: 'tool-started' }>

export interface TranscriptBackend {
  request(
    command: string,
    fields?: Record<string, unknown>,
    options?: { timeout?: 'default' | 'none' }
  ): Promise<unknown>
  subscribeFrames(listener: (frame: Record<string, unknown>) => void): () => void
}

export interface TranscriptServiceOptions {
  streamBroadcastIntervalMilliseconds?: number
}

export interface TranscriptService {
  readonly getSnapshot: () => TranscriptSnapshot
  readonly load: (sessionId: unknown) => Promise<void>
  readonly send: (sessionId: unknown, submission: unknown) => Promise<void>
  readonly abort: (sessionId: unknown) => Promise<void>
  readonly adoptActiveSession: (sessionId: unknown) => Promise<void>
  readonly respondToApproval: (
    sessionId: unknown,
    requestId: unknown,
    approved: unknown
  ) => Promise<void>
  readonly respondToClarification: (
    sessionId: unknown,
    requestId: unknown,
    answer: unknown
  ) => Promise<void>
  readonly subscribe: (listener: (update: TranscriptUpdate) => void) => () => void
  readonly dispose: () => void
}

export function createTranscriptService(
  backend: TranscriptBackend,
  options: TranscriptServiceOptions = {}
): TranscriptService {
  const listeners = new Set<(update: TranscriptUpdate) => void>()
  const streamBroadcastIntervalMilliseconds =
    options.streamBroadcastIntervalMilliseconds ?? defaultStreamBroadcastIntervalMilliseconds
  const toolMessageIds = new Map<string, string>()
  let abortPending = false
  let activeAssistantId: string | undefined
  let activeRunId: string | undefined
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined
  let loadSequence = 0
  let messageSequence = 0
  let sendSequence = 0
  let snapshot = emptyTranscriptSnapshot()

  const getSnapshot = (): TranscriptSnapshot => copyTranscriptSnapshot(snapshot)

  const publishSnapshot = (): void => {
    const nextSnapshot = getSnapshot()
    const update = { revision: nextSnapshot.revision, snapshot: nextSnapshot }
    listeners.forEach((listener) => listener(update))
  }

  const cancelPendingBroadcast = (): void => {
    if (broadcastTimer !== undefined) {
      clearTimeout(broadcastTimer)
      broadcastTimer = undefined
    }
  }

  const scheduleBroadcast = (): void => {
    broadcastTimer ??= setTimeout(() => {
      broadcastTimer = undefined
      publishSnapshot()
    }, streamBroadcastIntervalMilliseconds)
  }

  const commit = (action: TranscriptAction, coalesceBroadcast = false): void => {
    const next = reduceTranscriptSnapshot(snapshot, action)
    snapshot = { ...next, revision: snapshot.revision + 1 }
    if (coalesceBroadcast) {
      scheduleBroadcast()
      return
    }
    cancelPendingBroadcast()
    publishSnapshot()
  }

  const nextMessageId = (kind: string): string => {
    messageSequence += 1
    return `${kind}-${messageSequence}`
  }

  const finishActiveAssistant = (): void => {
    if (!activeAssistantId) {
      return
    }
    commit({ type: 'assistant-ended', id: activeAssistantId })
    activeAssistantId = undefined
  }

  const startAssistant = (coalesceBroadcast = false): string => {
    finishActiveAssistant()
    const id = nextMessageId('streaming-assistant')
    activeAssistantId = id
    commit({ type: 'assistant-started', id }, coalesceBroadcast)
    return id
  }

  const ensureAssistant = (): string => activeAssistantId ?? startAssistant(true)

  const ensureTool = ({
    toolCallId,
    name,
    target,
    detail,
    command
  }: NormalizedToolStartedFrame): void => {
    const presentation = {
      name,
      ...(target ? { target } : {}),
      ...(detail ? { detail } : {}),
      ...(command ? { command } : {})
    }
    const existingId = toolMessageIds.get(toolCallId)
    if (existingId) {
      commit(
        {
          type: 'tool-updated',
          id: existingId,
          ...presentation,
          running: true
        },
        true
      )
      return
    }
    const id = nextMessageId('streaming-tool')
    toolMessageIds.set(toolCallId, id)
    commit(
      {
        type: 'tool-started',
        message: {
          id,
          role: 'tool',
          ...presentation,
          failed: false,
          running: true
        }
      },
      true
    )
  }

  const consume = (frame: Record<string, unknown>): void => {
    if (snapshot.status !== 'running') {
      return
    }
    const normalized = normalizeTranscriptFrame(frame)
    if (!normalized) {
      return
    }
    switch (normalized.type) {
      case 'agent-started':
        activeRunId = normalized.runId
        return
      case 'agent-ended':
        if (!activeRunId || !normalized.runId || normalized.runId === activeRunId) {
          finishActiveAssistant()
        }
        return
      case 'assistant-started':
        startAssistant()
        return
      case 'assistant-delta':
        commit({ type: 'assistant-updated', id: ensureAssistant(), delta: normalized.delta }, true)
        return
      case 'assistant-ended':
        finishActiveAssistant()
        return
      case 'tool-started':
        ensureTool(normalized)
        return
      case 'tool-ended': {
        const id = toolMessageIds.get(normalized.toolCallId)
        if (id) {
          commit(
            {
              type: 'tool-updated',
              id,
              failed: normalized.failed,
              running: false,
              ...(normalized.output ? { output: normalized.output } : {})
            },
            true
          )
        }
        return
      }
      case 'interaction-requested':
        commit({ type: 'interaction-received', request: normalized.request })
    }
  }

  const unsubscribeFrames = backend.subscribeFrames(consume)

  const resetLiveState = (): void => {
    abortPending = false
    activeAssistantId = undefined
    activeRunId = undefined
    toolMessageIds.clear()
  }

  const hydrate = (sessionId: string): Promise<readonly TranscriptMessage[]> =>
    hydrateTranscript((fields) => backend.request('session_transcript', fields), sessionId)

  const isCurrentSend = (sequence: number, sessionId: string): boolean =>
    sequence === sendSequence && snapshot.sessionId === sessionId

  const load = async (sessionIdValue: unknown): Promise<void> => {
    const sessionId = validateSessionId(sessionIdValue)
    if (snapshot.status === 'running') {
      throw new Error('Cannot open another task while the agent is running')
    }
    const sequence = ++loadSequence
    resetLiveState()
    commit({ type: 'load-started', sessionId })
    try {
      const loaded = asObject(
        await backend.request('session_load', { sessionId, includeMessages: false })
      )
      if (loaded?.sessionId !== sessionId) {
        throw new Error('Invalid loaded session')
      }
      const messages = await hydrate(sessionId)
      if (sequence === loadSequence) {
        commit({ type: 'loaded', sessionId, messages })
      }
    } catch {
      if (sequence === loadSequence) {
        commit({ type: 'load-failed', sessionId })
      }
      throw new Error(transcriptLoadError)
    }
  }

  const adoptActiveSession = async (sessionIdValue: unknown): Promise<void> => {
    const sessionId = validateSessionId(sessionIdValue)
    if (snapshot.status === 'running') {
      throw new Error('Cannot change the active task while the agent is running')
    }
    const sequence = ++loadSequence
    resetLiveState()
    commit({ type: 'load-started', sessionId })
    try {
      const messages = await hydrate(sessionId)
      if (sequence === loadSequence) {
        commit({ type: 'loaded', sessionId, messages })
      }
    } catch {
      if (sequence === loadSequence) {
        commit({ type: 'load-failed', sessionId })
      }
      throw new Error(transcriptLoadError)
    }
  }

  const send = async (sessionIdValue: unknown, submission: unknown): Promise<void> => {
    const sessionId = validateSessionId(sessionIdValue)
    if (snapshot.sessionId !== sessionId) {
      throw new Error('The requested task does not match the loaded transcript')
    }
    if (snapshot.status === 'running') {
      throw new Error('The agent is already running')
    }
    if (snapshot.status !== 'ready') {
      throw new Error('The transcript is not ready')
    }

    const prompt = projectTranscriptPrompt(submission)
    const previousMessages = snapshot.messages
    const sequence = ++sendSequence
    resetLiveState()
    commit({ type: 'submitted', id: nextMessageId('optimistic-user'), text: prompt })

    try {
      await backend.request('prompt', { message: prompt }, { timeout: 'none' })
    } catch {
      if (isCurrentSend(sequence, sessionId)) {
        resetLiveState()
        commit({ type: 'send-failed', messages: previousMessages })
      }
      throw new Error(transcriptSendError)
    }

    if (!isCurrentSend(sequence, sessionId)) {
      return
    }
    resetLiveState()
    try {
      const messages = await hydrate(sessionId)
      if (isCurrentSend(sequence, sessionId)) {
        commit({ type: 'loaded', sessionId, messages })
      }
    } catch {
      if (isCurrentSend(sequence, sessionId)) {
        commit({ type: 'load-failed', sessionId })
      }
    }
  }

  const abort = async (sessionIdValue: unknown): Promise<void> => {
    const sessionId = validateSessionId(sessionIdValue)
    if (snapshot.sessionId !== sessionId) {
      throw new Error('The requested task does not match the loaded transcript')
    }
    if (snapshot.status !== 'running') {
      throw new Error('The agent is not running')
    }
    if (abortPending) {
      throw new Error('A stop request is already pending')
    }
    abortPending = true
    try {
      await backend.request('abort', {}, { timeout: 'none' })
    } catch {
      abortPending = false
      throw new Error('Could not stop the response. Try again.')
    }
  }

  const interactionRequest = (
    sessionIdValue: unknown,
    requestIdValue: unknown
  ): TranscriptInteractionRequest => {
    const sessionId = validateSessionId(sessionIdValue)
    if (snapshot.sessionId !== sessionId || snapshot.status !== 'running') {
      throw new Error('The interaction does not belong to the active task')
    }
    if (typeof requestIdValue !== 'string') {
      throw new Error('The interaction request is invalid')
    }
    const request = snapshot.interactions.find(({ id }) => id === requestIdValue)
    if (!request) {
      throw new Error('The interaction request is no longer pending')
    }
    if (request.status === 'responding') {
      throw new Error('The interaction response is already pending')
    }
    return request
  }

  const respond = async (
    requestId: string,
    command: 'approval_response' | 'clarification_response',
    fields: Record<string, unknown>
  ): Promise<void> => {
    commit({ type: 'interaction-response-started', id: requestId })
    try {
      await backend.request(command, fields, { timeout: 'none' })
      commit({ type: 'interaction-response-succeeded', id: requestId })
    } catch {
      commit({ type: 'interaction-response-failed', id: requestId })
      throw new Error('The interaction response could not be completed.')
    }
  }

  const respondToApproval = async (
    sessionIdValue: unknown,
    requestIdValue: unknown,
    approvedValue: unknown
  ): Promise<void> => {
    const request = interactionRequest(sessionIdValue, requestIdValue)
    if (request.type !== 'approval' || typeof approvedValue !== 'boolean') {
      throw new Error('The interaction response is invalid')
    }
    await respond(request.id, 'approval_response', {
      requestId: request.id,
      approved: approvedValue
    })
  }

  const respondToClarification = async (
    sessionIdValue: unknown,
    requestIdValue: unknown,
    answerValue: unknown
  ): Promise<void> => {
    const request = interactionRequest(sessionIdValue, requestIdValue)
    if (request.type !== 'clarification') {
      throw new Error('The interaction response is invalid')
    }
    await respond(request.id, 'clarification_response', {
      requestId: request.id,
      answer: validateClarificationAnswer(answerValue)
    })
  }

  return {
    getSnapshot,
    load,
    adoptActiveSession,
    send,
    abort,
    respondToApproval,
    respondToClarification,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      cancelPendingBroadcast()
      unsubscribeFrames()
      listeners.clear()
    }
  }
}
