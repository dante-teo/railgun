import assert from 'node:assert/strict'
import test from 'node:test'

import {
  emptyTranscriptSnapshot,
  projectTranscriptPrompt,
  type TranscriptUpdate
} from '../shared/transcript-api.ts'
import { createTranscriptService, type TranscriptBackend } from './transcript.mts'
import {
  copyTranscriptSnapshot,
  normalizeTranscriptFrame,
  reduceTranscriptSnapshot
} from './transcript-state.mts'

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
          },
          {
            role: 'tool',
            id: 'restored-tool-3',
            name: 'write_file',
            target: '/private/project/notes.txt',
            detail: 'notes.txt',
            fileChange: {
              status: 'changed',
              diff: '--- notes.txt\n+++ notes.txt\n@@ -1 +1 @@\n-old\n+new\n',
              truncated: false
            },
            failed: false
          }
        ],
        nextCursor: 4
      }
    }
    if (command === 'session_transcript' && fields.cursor === 4) {
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
        id: 'restored-tool-3',
        role: 'tool',
        name: 'write_file',
        target: 'notes.txt',
        detail: 'notes.txt',
        fileChange: {
          status: 'changed',
          diff: '--- notes.txt\n+++ notes.txt\n@@ -1 +1 @@\n-old\n+new\n',
          truncated: false
        },
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
      ['session_transcript', 4]
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

test('file-change payloads are bounded and rejected for malformed or inappropriate tools', async () => {
  const oversized = `--- notes.txt\n+++ notes.txt\n@@ -1 +1,5000 @@\n-old\n${'+🙂\n'.repeat(5_000)}`
  const normalized = normalizeTranscriptFrame({
    type: 'tool_execution_end',
    toolCallId: 'write-one',
    toolName: 'write_file',
    result: {
      content: 'Wrote',
      isError: false,
      fileChange: { status: 'changed', diff: oversized, truncated: false }
    }
  })
  assert.ok(normalized && normalized.type === 'tool-ended')
  assert.equal(normalized.name, 'write_file')
  assert.equal(normalized.fileChange?.status, 'changed')
  if (normalized.fileChange?.status === 'changed') {
    assert.equal(normalized.fileChange.truncated, true)
    assert.ok(new TextEncoder().encode(normalized.fileChange.diff).length <= 16_384)
    assert.match(normalized.fileChange.diff, /^--- notes\.txt\n\+\+\+ notes\.txt\n/)
    assert.match(normalized.fileChange.diff, /…$/)
  }

  for (const [toolName, isError, fileChange] of [
    ['delete_file', false, { status: 'unchanged' }],
    ['write_file', true, { status: 'unavailable' }],
    ['create_file', false, { status: 'changed', diff: 'missing flag' }],
    [
      'write_file',
      false,
      {
        status: 'changed',
        diff: '--- /private/notes.txt\n+++ /private/notes.txt\n',
        truncated: false
      }
    ]
  ] as const) {
    assert.equal(
      normalizeTranscriptFrame({
        type: 'tool_execution_end',
        toolCallId: `invalid-${toolName}`,
        toolName,
        result: { content: 'result', isError, fileChange }
      }),
      undefined
    )
  }
})

test('file-change metadata is copied at reducer and snapshot boundaries', () => {
  const originalDiff = '--- notes.txt\n+++ notes.txt\n@@ -1 +1 @@\n-old\n+new\n'
  const actionFileChange = {
    status: 'changed' as const,
    diff: originalDiff,
    truncated: false
  }
  const started = reduceTranscriptSnapshot(emptyTranscriptSnapshot(), {
    type: 'tool-started',
    message: {
      id: 'write-one',
      role: 'tool',
      name: 'write_file',
      failed: false,
      running: true
    }
  })
  const reduced = reduceTranscriptSnapshot(started, {
    type: 'tool-updated',
    id: 'write-one',
    fileChange: actionFileChange,
    failed: false,
    running: false
  })
  const storedMessage = reduced.messages[0]
  assert.ok(storedMessage?.role === 'tool' && storedMessage.fileChange?.status === 'changed')
  assert.notEqual(storedMessage.fileChange, actionFileChange)

  actionFileChange.diff = 'mutated action payload'
  assert.equal(storedMessage.fileChange.diff, originalDiff)

  const copied = copyTranscriptSnapshot(reduced)
  const copiedMessage = copied.messages[0]
  assert.ok(copiedMessage?.role === 'tool' && copiedMessage.fileChange?.status === 'changed')
  assert.notEqual(copiedMessage.fileChange, storedMessage.fileChange)

  const mutableCopiedFileChange = copiedMessage.fileChange as { diff: string }
  mutableCopiedFileChange.diff = 'mutated renderer snapshot'
  assert.equal(storedMessage.fileChange.diff, originalDiff)
})

test('completed tool-only turns remove their empty assistant placeholder', () => {
  const withAssistant = reduceTranscriptSnapshot(emptyTranscriptSnapshot(), {
    type: 'assistant-started',
    id: 'assistant-one'
  })
  const withTool = reduceTranscriptSnapshot(withAssistant, {
    type: 'tool-started',
    message: {
      id: 'tool-one',
      role: 'tool',
      name: 'run_shell_command',
      failed: false,
      running: true
    }
  })

  const completed = reduceTranscriptSnapshot(withTool, {
    type: 'assistant-ended',
    id: 'assistant-one'
  })

  assert.deepEqual(completed.messages, [withTool.messages[1]])
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

test('creating a transcript uses the configured model and publishes an empty ready snapshot', async () => {
  const backend = stubTranscriptBackend(async ({ command, fields }) => {
    if (command === 'config_get') {
      return { config: { model: 'gpt-5' } }
    }
    if (command === 'get_available_models') {
      return { models: [{ id: 'gpt-5', name: 'GPT-5' }] }
    }
    if (command === 'session_new') {
      assert.deepEqual(fields, { modelId: 'gpt-5' })
      return { sessionId: 'new-session' }
    }
    throw new Error(`Unexpected request: ${command}`)
  })
  const service = createTranscriptService(backend)
  const updates: TranscriptUpdate[] = []
  service.subscribe((update) => updates.push(update))

  assert.equal(await service.create(), 'new-session')
  assert.deepEqual(service.getSnapshot(), {
    revision: 1,
    sessionId: 'new-session',
    status: 'ready',
    messages: [],
    interactions: [],
    error: null
  })
  assert.deepEqual(updates, [{ revision: 1, snapshot: service.getSnapshot() }])
  assert.deepEqual(
    backend.requests.map(({ command }) => command),
    ['config_get', 'get_available_models', 'session_new']
  )
  service.dispose()
})

test('creating a transcript omits a configured model that is absent from the catalog', async () => {
  const backend = stubTranscriptBackend(async ({ command, fields }) => {
    if (command === 'config_get') {
      return { config: { model: 'removed-model' } }
    }
    if (command === 'get_available_models') {
      return { models: [{ id: 'gpt-5', name: 'GPT-5' }] }
    }
    if (command === 'session_new') {
      assert.deepEqual(fields, {})
      return { sessionId: 'new-session' }
    }
    throw new Error(`Unexpected request: ${command}`)
  })
  const service = createTranscriptService(backend)

  assert.equal(await service.create(), 'new-session')
  assert.equal(service.getSnapshot().sessionId, 'new-session')
  service.dispose()
})

test('creating a transcript rejects malformed IDs and preserves the prior snapshot on failure', async () => {
  const backend = stubTranscriptBackend(async ({ command }) => {
    if (command === 'session_load') {
      return { sessionId: 'saved-session' }
    }
    if (command === 'session_transcript') {
      return {
        sessionId: 'saved-session',
        messages: [{ role: 'user', messageId: 7, text: 'Keep this visible' }]
      }
    }
    if (command === 'config_get') {
      return { config: { model: 'gpt-5' } }
    }
    if (command === 'get_available_models') {
      return { models: [{ id: 'gpt-5', name: 'GPT-5' }] }
    }
    if (command === 'session_new') {
      return { sessionId: ' invalid-session ' }
    }
    throw new Error(`Unexpected request: ${command}`)
  })
  const service = createTranscriptService(backend)
  await service.load('saved-session')
  const previous = service.getSnapshot()

  await assert.rejects(service.create(), /Could not create a new task/)
  assert.deepEqual(service.getSnapshot(), previous)
  service.dispose()
})

test('creating a transcript is rejected without backend requests while an agent is running', async () => {
  const prompt = deferred<unknown>()
  const backend = stubTranscriptBackend(async ({ command }) => {
    if (command === 'session_load') {
      return { sessionId: 'saved-session' }
    }
    if (command === 'session_transcript') {
      return { sessionId: 'saved-session', messages: [] }
    }
    if (command === 'prompt') {
      return prompt.promise
    }
    throw new Error(`Unexpected request: ${command}`)
  })
  const service = createTranscriptService(backend)
  await service.load('saved-session')
  const sending = service.send('saved-session', { text: 'Keep running', attachments: [] })
  const requestCount = backend.requests.length

  await assert.rejects(service.create(), /running/i)
  assert.equal(backend.requests.length, requestCount)

  prompt.resolve(undefined)
  await sending
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
      result: {
        content: 'private file result',
        isError: false,
        ...(name === 'create_file'
          ? {
              fileChange: {
                status: 'changed',
                diff: '--- created.txt\n+++ created.txt\n@@ -0,0 +1 @@\n+created\n',
                truncated: false
              }
            }
          : {})
      }
    })
  }
  backend.emit({
    type: 'message_update',
    streamEvent: { type: 'toolcall_start', id: 'call-mismatched', name: 'read_file' }
  })
  backend.emit({
    type: 'message_update',
    streamEvent: {
      type: 'toolcall_end',
      id: 'call-mismatched',
      name: 'write_file',
      arguments: { path: '/private/project/mismatch.txt', content: 'private mismatch' }
    }
  })
  backend.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-mismatched',
    toolName: 'write_file',
    result: {
      content: 'private mismatched result',
      isError: false,
      fileChange: {
        status: 'changed',
        diff: '--- mismatch.txt\n+++ mismatch.txt\n@@ -0,0 +1 @@\n+must-not-attach\n',
        truncated: false
      }
    }
  })
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
  assert.match(encoded, /"fileChange":\{"status":"changed","diff":"--- created\.txt/)
  assert.match(encoded, /"name":"delete_file"[^}]*"target":"deleted\.txt"/)
  assert.match(encoded, /"failed":true/)
  assert.match(encoded, /"command":"pnpm test"/)
  assert.match(encoded, /"output":"21 tests passed"/)
  assert.doesNotMatch(
    encoded,
    /private chain of thought|private arguments|raw-secret|sensitive tool result|private file content|private file result|private mismatched result|must-not-attach|\/private\//
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
