import assert from 'node:assert/strict'
import test from 'node:test'

import { projectTranscriptPrompt, type TranscriptUpdate } from '../shared/transcript-api.ts'
import { createTranscriptService, type TranscriptBackend } from './transcript.mts'

interface PendingRequest {
  readonly command: string
  readonly fields: Record<string, unknown>
  readonly options: { timeout?: 'default' | 'none' } | undefined
}

interface StubTranscriptBackend extends TranscriptBackend {
  readonly listeners: Set<(frame: Record<string, unknown>) => void>
  readonly requests: PendingRequest[]
  emit: (frame: Record<string, unknown>) => void
  handler: (request: PendingRequest) => Promise<unknown>
}

function stubTranscriptBackend(
  handler: StubTranscriptBackend['handler'] = async () => undefined
): StubTranscriptBackend {
  const listeners = new Set<(frame: Record<string, unknown>) => void>()
  const requests: PendingRequest[] = []
  const backend: StubTranscriptBackend = {
    listeners,
    requests,
    handler,
    request: async (command, fields = {}, options) => {
      const request = { command, fields, options }
      requests.push(request)
      return backend.handler(request)
    },
    subscribeFrames: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (frame) => listeners.forEach((listener) => listener(frame))
  }
  return backend
}

function deferred<Value>(): {
  readonly promise: Promise<Value>
  readonly reject: (reason?: unknown) => void
  readonly resolve: (value: Value) => void
} {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

test('prompt projection trims drafts, supports attachment-only sends, and enforces the final limit', () => {
  assert.equal(
    projectTranscriptPrompt({
      text: '  Inspect this  ',
      attachments: [
        { kind: 'file', name: 'notes.txt', path: '/tmp/notes.txt' },
        { kind: 'folder', name: 'project', path: '/tmp/project' }
      ]
    }),
    'Inspect this\n\nAttachments:\n- file: /tmp/notes.txt\n- folder: /tmp/project'
  )
  assert.equal(
    projectTranscriptPrompt({
      text: '  ',
      attachments: [{ kind: 'file', name: 'notes.txt', path: '/tmp/notes.txt' }]
    }),
    'Attachments:\n- file: /tmp/notes.txt'
  )
  assert.throws(
    () => projectTranscriptPrompt({ text: '', attachments: [] }),
    /Enter a message or attach a file or folder/
  )
  assert.throws(
    () => projectTranscriptPrompt({ text: 'x'.repeat(100_001), attachments: [] }),
    /100,000/
  )
})

test('transcript hydration validates and collects every page into an immutable snapshot', async () => {
  const backend = stubTranscriptBackend(async ({ command, fields }) => {
    if (command === 'session_load') {
      return { sessionId: 'session-one' }
    }
    if (command === 'session_transcript' && fields.cursor === 0) {
      return {
        sessionId: 'session-one',
        messages: [
          { role: 'user', messageId: 11, text: 'Question', startedAt: 1_000 },
          {
            role: 'tool',
            id: 'restored-tool-1',
            name: 'read_file',
            target: '/private/project/notes.txt',
            detail: 'notes.txt',
            failed: false,
            arguments: { token: 'must-not-cross' }
          },
          {
            role: 'tool',
            id: 'restored-tool-2',
            name: 'run_shell_command',
            detail: 'Local shell command',
            command: 'pnpm test',
            output: '21 tests passed',
            failed: false
          }
        ],
        nextCursor: 3
      }
    }
    if (command === 'session_transcript' && fields.cursor === 3) {
      return {
        sessionId: 'session-one',
        messages: [
          {
            role: 'assistant',
            messageId: 12,
            text: 'Answer',
            branchable: true,
            completedAt: 208_000
          }
        ]
      }
    }
    throw new Error(`Unexpected request: ${command}`)
  })
  const service = createTranscriptService(backend)
  const updates: TranscriptUpdate[] = []
  service.subscribe((update) => updates.push(update))

  await service.load('session-one')

  const snapshot = service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  assert.deepEqual(
    snapshot.messages.map((message) => ({ ...message })),
    [
      { id: 'message-11', role: 'user', text: 'Question', startedAt: 1_000 },
      {
        id: 'restored-tool-1',
        role: 'tool',
        name: 'read_file',
        target: 'notes.txt',
        detail: 'notes.txt',
        failed: false
      },
      {
        id: 'restored-tool-2',
        role: 'tool',
        name: 'run_shell_command',
        detail: 'Local shell command',
        command: 'pnpm test',
        output: '21 tests passed',
        failed: false
      },
      {
        id: 'message-12',
        role: 'assistant',
        text: 'Answer',
        status: 'complete',
        completedAt: 208_000
      }
    ]
  )
  assert.deepEqual(
    backend.requests.map(({ command, fields }) => [command, fields.cursor]),
    [
      ['session_load', undefined],
      ['session_transcript', 0],
      ['session_transcript', 3]
    ]
  )
  assert.ok(updates.every((update) => update.revision === update.snapshot.revision))
  assert.ok(
    updates.every((update, index) => index === 0 || update.revision > updates[index - 1].revision)
  )

  const mutable = snapshot.messages as unknown as Array<{ text?: string }>
  mutable[0] = { text: 'mutated' }
  assert.equal(service.getSnapshot().messages[0]?.id, 'message-11')
  assert.doesNotMatch(JSON.stringify(service.getSnapshot()), /must-not-cross|\/private\//)
  service.dispose()
})

test('transcript loading rejects malformed pages without exposing backend details', async () => {
  const backend = stubTranscriptBackend(async ({ command }) =>
    command === 'session_load'
      ? { sessionId: 'session-one' }
      : {
          sessionId: 'different-session',
          messages: []
        }
  )
  const service = createTranscriptService(backend)

  await assert.rejects(service.load('session-one'), /Could not load this transcript/)
  assert.deepEqual(service.getSnapshot(), {
    revision: 2,
    sessionId: 'session-one',
    status: 'error',
    messages: [],
    interactions: [],
    error: 'Could not load this transcript. Try reopening the task.'
  })
  service.dispose()
})

test('transcript hydration accepts legacy messages without IDs and rejects empty continuations', async () => {
  const backend = stubTranscriptBackend(async ({ command }) =>
    command === 'session_load'
      ? { sessionId: 'session-one' }
      : {
          sessionId: 'session-one',
          messages: [{ role: 'user', text: 'Legacy message' }]
        }
  )
  const service = createTranscriptService(backend)

  await service.load('session-one')
  assert.equal(service.getSnapshot().messages[0]?.id, 'restored-message-0')

  backend.handler = async ({ command }) =>
    command === 'session_load'
      ? { sessionId: 'session-one' }
      : { sessionId: 'session-one', messages: [], nextCursor: 1 }
  await assert.rejects(service.load('session-one'), /Could not load this transcript/)
  service.dispose()
})

test('adopting a model-forked active session rehydrates without loading a saved task', async () => {
  const backend = stubTranscriptBackend(async ({ command, fields }) => {
    if (command === 'session_load') {
      return { sessionId: 'session-one' }
    }
    if (command === 'session_transcript') {
      return fields.sessionId === 'fork-session-one'
        ? {
            sessionId: 'fork-session-one',
            messages: [{ role: 'user', messageId: 11, text: 'Preserved history' }]
          }
        : { sessionId: 'session-one', messages: [] }
    }
    throw new Error(`Unexpected request: ${command}`)
  })
  const service = createTranscriptService(backend)
  await service.load('session-one')
  await service.adoptActiveSession('fork-session-one')

  assert.equal(service.getSnapshot().sessionId, 'fork-session-one')
  assert.equal(service.getSnapshot().messages[0]?.id, 'message-11')
  assert.equal(
    backend.requests.filter(({ command }) => command === 'session_load').length,
    1,
    'the backend already activated the fork during set_model'
  )
  service.dispose()
})

test('live reduction batches text, normalizes tools, and hides private frames and payloads', async () => {
  const prompt = deferred<unknown>()
  let transcriptReads = 0
  const backend = stubTranscriptBackend(async ({ command }) => {
    if (command === 'session_load') {
      return { sessionId: 'session-one' }
    }
    if (command === 'session_transcript') {
      transcriptReads += 1
      return { sessionId: 'session-one', messages: [] }
    }
    if (command === 'prompt') {
      return prompt.promise
    }
    if (command === 'abort') {
      return undefined
    }
    throw new Error(`Unexpected request: ${command}`)
  })
  const service = createTranscriptService(backend, { streamBroadcastIntervalMilliseconds: 10 })
  await service.load('session-one')
  const updates: TranscriptUpdate[] = []
  service.subscribe((update) => updates.push(update))
  const sending = service.send('session-one', { text: 'Run it', attachments: [] })

  const runningSnapshot = service.getSnapshot()
  await assert.rejects(service.load('session-two'), /running/i)
  assert.deepEqual(service.getSnapshot(), runningSnapshot)

  backend.emit({ type: 'agent_start', runId: 'run-one' })
  backend.emit({
    type: 'message_update',
    streamEvent: { type: 'thinking_delta', delta: 'private chain of thought' }
  })
  backend.emit({
    type: 'message_update',
    streamEvent: { type: 'text_delta', delta: 'One ' }
  })
  backend.emit({
    type: 'message_update',
    streamEvent: { type: 'text_delta', delta: 'two' }
  })
  backend.emit({
    type: 'message_update',
    streamEvent: { type: 'toolcall_start', id: 'call-one', name: 'read_file' }
  })
  backend.emit({
    type: 'message_update',
    streamEvent: {
      type: 'toolcall_delta',
      id: 'call-one',
      delta: 'private arguments',
      arguments: { path: '/private/project/token.txt', token: 'raw-secret' }
    }
  })
  backend.emit({
    type: 'message_update',
    streamEvent: {
      type: 'toolcall_end',
      id: 'call-one',
      name: 'read_file',
      arguments: { path: '/private/project/token.txt', token: 'raw-secret' }
    }
  })
  backend.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-one',
    toolName: 'read_file',
    result: { content: 'sensitive tool result', isError: true }
  })
  for (const [id, name, path] of [
    ['call-create', 'create_file', '/private/project/created.txt'],
    ['call-delete', 'delete_file', '/private/project/deleted.txt']
  ] as const) {
    backend.emit({
      type: 'message_update',
      streamEvent: { type: 'toolcall_start', id, name }
    })
    backend.emit({
      type: 'message_update',
      streamEvent: {
        type: 'toolcall_end',
        id,
        name,
        arguments: { path, content: 'private file content' }
      }
    })
    backend.emit({
      type: 'tool_execution_end',
      toolCallId: id,
      toolName: name,
      result: { content: 'private file result', isError: false }
    })
  }
  backend.emit({
    type: 'message_update',
    streamEvent: { type: 'toolcall_start', id: 'call-shell', name: 'run_shell_command' }
  })
  backend.emit({
    type: 'message_update',
    streamEvent: {
      type: 'toolcall_end',
      id: 'call-shell',
      name: 'run_shell_command',
      arguments: { command: '\u001b[31mpnpm test\u001b[0m' }
    }
  })
  backend.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-shell',
    toolName: 'run_shell_command',
    result: { content: '\u001b[32m21 tests passed\u001b[0m', isError: false }
  })

  assert.equal(updates.length, 1, 'only the optimistic submission publishes synchronously')
  assert.equal(service.getSnapshot().messages[1]?.role, 'assistant')
  await delay(20)
  assert.equal(updates.length, 2, 'streaming frames publish as one batch')
  const encoded = JSON.stringify(service.getSnapshot())
  assert.match(encoded, /One two/)
  assert.match(encoded, /token\.txt/)
  assert.match(encoded, /"name":"create_file"[^}]*"target":"created\.txt"/)
  assert.match(encoded, /"name":"delete_file"[^}]*"target":"deleted\.txt"/)
  assert.match(encoded, /"failed":true/)
  assert.match(encoded, /"command":"pnpm test"/)
  assert.match(encoded, /"output":"21 tests passed"/)
  assert.doesNotMatch(
    encoded,
    /private chain of thought|private arguments|raw-secret|sensitive tool result|private file content|private file result|\/private\//
  )

  await service.abort('session-one')
  assert.equal(backend.requests.at(-1)?.command, 'abort')
  await assert.rejects(
    service.send('session-one', { text: 'Duplicate', attachments: [] }),
    /running/
  )
  await assert.rejects(service.abort('different-session'), /does not match/)

  prompt.resolve(undefined)
  await sending
  assert.equal(transcriptReads, 2, 'completion performs an authoritative rehydration')
  assert.equal(service.getSnapshot().status, 'ready')
  service.dispose()
})

test('interaction requests stay renderer-safe and remain retryable until acknowledged', async () => {
  const prompt = deferred<unknown>()
  let rejectApproval = true
  const backend = stubTranscriptBackend(async ({ command }) => {
    if (command === 'session_load') {
      return { sessionId: 'session-one' }
    }
    if (command === 'session_transcript') {
      return { sessionId: 'session-one', messages: [] }
    }
    if (command === 'prompt') {
      return prompt.promise
    }
    if (command === 'approval_response' && rejectApproval) {
      throw new Error('transport secret')
    }
    if (command === 'approval_response' || command === 'clarification_response') {
      return undefined
    }
    throw new Error(`Unexpected request: ${command}`)
  })
  const service = createTranscriptService(backend)
  await service.load('session-one')
  const sending = service.send('session-one', { text: 'Run protected work', attachments: [] })

  backend.emit({
    type: 'approval_request',
    requestId: 'approval-one',
    command: 'sudo launch-safe-command'
  })
  assert.deepEqual(service.getSnapshot().interactions, [
    {
      id: 'approval-one',
      type: 'approval',
      command: 'sudo launch-safe-command',
      status: 'pending',
      error: null
    }
  ])

  await assert.rejects(
    service.respondToApproval('session-one', 'approval-one', true),
    /could not be completed/i
  )
  assert.equal(service.getSnapshot().interactions[0]?.status, 'pending')
  assert.doesNotMatch(JSON.stringify(service.getSnapshot()), /transport secret/)

  rejectApproval = false
  await service.respondToApproval('session-one', 'approval-one', false)
  assert.deepEqual(service.getSnapshot().interactions, [])
  assert.deepEqual(backend.requests.at(-1), {
    command: 'approval_response',
    fields: { requestId: 'approval-one', approved: false },
    options: { timeout: 'none' }
  })

  backend.emit({
    type: 'clarification_request',
    requestId: 'clarification-one',
    question: 'Which path should be used?',
    choices: ['Fast', 'Safe']
  })
  assert.deepEqual(service.getSnapshot().interactions, [
    {
      id: 'clarification-one',
      type: 'clarification',
      question: 'Which path should be used?',
      choices: ['Fast', 'Safe'],
      status: 'pending',
      error: null
    }
  ])
  await service.respondToClarification('session-one', 'clarification-one', '  Safe  ')
  assert.deepEqual(backend.requests.at(-1), {
    command: 'clarification_response',
    fields: { requestId: 'clarification-one', answer: 'Safe' },
    options: { timeout: 'none' }
  })
  assert.deepEqual(service.getSnapshot().interactions, [])

  prompt.resolve(undefined)
  await sending
  service.dispose()
})

test('successful sends rehydrate persisted IDs while rejected sends roll back safely for retry', async () => {
  const prompt = deferred<unknown>()
  let completed = false
  const backend = stubTranscriptBackend(async ({ command }) => {
    if (command === 'session_load') {
      return { sessionId: 'session-one' }
    }
    if (command === 'session_transcript') {
      return completed
        ? {
            sessionId: 'session-one',
            messages: [
              { role: 'user', messageId: 31, text: 'Persist me' },
              { role: 'assistant', messageId: 32, text: 'Persisted answer' }
            ]
          }
        : { sessionId: 'session-one', messages: [] }
    }
    if (command === 'prompt') {
      return prompt.promise
    }
    throw new Error(`Unexpected request: ${command}`)
  })
  const service = createTranscriptService(backend)
  await service.load('session-one')
  const sending = service.send('session-one', { text: 'Persist me', attachments: [] })
  assert.match(service.getSnapshot().messages[0]?.id ?? '', /^optimistic-user-/)

  completed = true
  prompt.resolve(undefined)
  await sending
  assert.deepEqual(
    service.getSnapshot().messages.map(({ id }) => id),
    ['message-31', 'message-32']
  )

  backend.handler = async ({ command }) => {
    if (command === 'prompt') {
      throw new Error('provider leaked detail')
    }
    throw new Error(`Unexpected request: ${command}`)
  }
  await assert.rejects(
    service.send('session-one', { text: 'Fail safely', attachments: [] }),
    /Could not send the message/
  )
  const snapshot = service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.error, 'Could not send the message. Try again.')
  assert.deepEqual(
    snapshot.messages.map(({ id }) => id),
    ['message-31', 'message-32']
  )
  assert.doesNotMatch(JSON.stringify(snapshot), /provider leaked detail/)

  backend.handler = async ({ command }) => {
    if (command === 'prompt') {
      return undefined
    }
    if (command === 'session_transcript') {
      return {
        sessionId: 'session-one',
        messages: [
          { role: 'user', messageId: 31, text: 'Persist me' },
          { role: 'assistant', messageId: 32, text: 'Persisted answer' }
        ]
      }
    }
    throw new Error(`Unexpected request: ${command}`)
  }
  await service.send('session-one', { text: 'Retry safely', attachments: [] })
  assert.equal(service.getSnapshot().status, 'ready')
  service.dispose()
})
