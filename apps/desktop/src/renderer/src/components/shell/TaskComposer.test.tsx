import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskComposer } from '@/components/shell/TaskComposer'
import { emptyActivitySnapshot } from '@/lib/activity-api'
import type { ComposerAttachment } from '@/lib/attachment-api'
import type { ApprovalApi, ApprovalConfiguration } from '@/lib/approval-api'
import { emptyContextUsageSnapshot } from '@/lib/context-usage-api'
import type { ModelApi, ModelConfiguration } from '@/lib/model-api'
import { emptyTranscriptSnapshot, type TranscriptSnapshot } from '@/lib/transcript-api'

const manualApproval: ApprovalConfiguration = {
  mode: 'manual',
  reviewerModelId: null
}

const defaultModelConfiguration: ModelConfiguration = {
  activeSessionId: 'session-one',
  activeModelId: 'gpt-5',
  defaultModelId: 'gpt-5',
  isRunning: false,
  models: [
    { id: 'gpt-5', name: 'GPT-5' },
    { id: 'claude-sonnet', name: 'Claude Sonnet' }
  ],
  warning: null
}

function deferred<Value>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
} {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function installComposerApi({
  getApproval = async () => manualApproval,
  getModels = async () => defaultModelConfiguration,
  pick = async () => [],
  send = async () => undefined,
  abort = async () => undefined,
  selectModel = async (modelId) => ({
    ...defaultModelConfiguration,
    activeModelId: modelId,
    defaultModelId: modelId
  }),
  setApprovalMode = async (mode) => ({ ...manualApproval, mode })
}: {
  getApproval?: ApprovalApi['get']
  getModels?: ModelApi['get']
  pick?: () => Promise<readonly ComposerAttachment[]>
  send?: (
    sessionId: string,
    submission: { text: string; attachments: readonly ComposerAttachment[] }
  ) => Promise<void>
  abort?: (sessionId: string) => Promise<void>
  selectModel?: ModelApi['select']
  setApprovalMode?: ApprovalApi['setMode']
} = {}): void {
  Object.defineProperty(window, 'railgun', {
    configurable: true,
    value: {
      activity: {
        getSnapshot: async () => emptyActivitySnapshot(),
        subscribe: () => () => undefined
      },
      attachments: { pick },
      approval: { get: getApproval, setMode: setApprovalMode },
      contextUsage: {
        getSnapshot: async () => emptyContextUsageSnapshot(),
        subscribe: () => () => undefined
      },
      models: { get: getModels, select: selectModel },
      tasks: {
        archive: async () => undefined,
        list: async () => [],
        open: async () => undefined
      },
      transcript: {
        abort,
        getSnapshot: async () => emptyTranscriptSnapshot(),
        send,
        subscribe: () => () => undefined
      }
    }
  })
}

beforeEach(() => installComposerApi())
afterEach(cleanup)

describe('TaskComposer', () => {
  it('exposes selector and send states for motion while owning approval behavior', async () => {
    const { rerender } = render(
      <TaskComposer approvalExpanded={false} modelExpanded={false} sending={false} />
    )
    const approval = screen.getByRole('button', { name: 'Approval mode: Ask for approval' })
    const model = await screen.findByRole('button', { name: 'Select model: GPT-5' })
    const send = screen.getByRole('button', { name: 'Send message' })

    expect(screen.getByRole('group', { name: 'Composer controls' })).toBeInTheDocument()
    expect(approval).toHaveAttribute('aria-expanded', 'false')
    expect(model).toHaveAttribute('aria-expanded', 'false')
    expect(send).toHaveAttribute('data-state', 'idle')

    await waitFor(() => expect(approval).toBeEnabled())

    rerender(<TaskComposer approvalExpanded modelExpanded sending />)

    expect(approval).toHaveAttribute('aria-expanded', 'true')
    expect(model).toHaveAttribute('aria-expanded', 'true')
    expect(send).toHaveAccessibleName('Stop generation')
    expect(send).toHaveAttribute('data-state', 'sending')
  })

  it('submits on Return, keeps Shift+Return and IME composition as text input, and clears accepted drafts', async () => {
    const request = deferred<void>()
    const send = vi.fn(() => request.promise)
    const onSubmissionCompleted = vi.fn()
    installComposerApi({ send })
    const transcript: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: 'session-one',
      status: 'ready'
    }
    render(
      <TaskComposer
        onSubmissionCompleted={onSubmissionCompleted}
        sessionId="session-one"
        transcript={transcript}
      />
    )
    const message = screen.getByRole('textbox', { name: 'Message' })

    fireEvent.change(message, { target: { value: 'Hello' } })
    fireEvent.keyDown(message, { key: 'Enter', shiftKey: true })
    expect(send).not.toHaveBeenCalled()

    fireEvent.compositionStart(message)
    fireEvent.keyDown(message, { key: 'Enter' })
    fireEvent.compositionEnd(message)
    expect(send).not.toHaveBeenCalled()

    fireEvent.keyDown(message, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith('session-one', { text: 'Hello', attachments: [] })
    expect(message).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeInTheDocument()

    await act(async () => request.resolve())
    expect(onSubmissionCompleted).toHaveBeenCalledOnce()
  })

  it('submits attachments with the draft and restores both when the send is rejected', async () => {
    const attachment = {
      kind: 'folder',
      name: 'project',
      path: '/tmp/project'
    } as const
    const send = vi.fn(async () => {
      throw new Error('Could not send the message. Try again.')
    })
    installComposerApi({ pick: async () => [attachment], send })
    const transcript: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: 'session-one',
      status: 'ready'
    }
    render(<TaskComposer sessionId="session-one" transcript={transcript} />)
    const message = screen.getByRole('textbox', { name: 'Message' })

    fireEvent.change(message, { target: { value: '  Inspect  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }))
    await screen.findByText('project')
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('session-one', {
        text: '  Inspect  ',
        attachments: [attachment]
      })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send the message')
    expect(message).toHaveValue('  Inspect  ')
    expect(screen.getByText('project')).toBeInTheDocument()
  })

  it('keeps attachment-only and oversized drafts disabled', async () => {
    const attachment = { kind: 'file', name: 'notes.txt', path: '/tmp/notes.txt' } as const
    const send = vi.fn(async () => undefined)
    installComposerApi({ pick: async () => [attachment], send })
    const transcript: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: 'session-one',
      status: 'ready'
    }
    render(<TaskComposer sessionId="session-one" transcript={transcript} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }))
    await screen.findByText('notes.txt')
    const sendButton = screen.getByRole('button', { name: 'Send message' })
    expect(sendButton).toBeDisabled()

    const message = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.keyDown(message, { key: 'Enter' })
    expect(send).not.toHaveBeenCalled()

    fireEvent.change(message, { target: { value: 'Describe this' } })
    expect(sendButton).toBeEnabled()
    fireEvent.change(message, { target: { value: '   ' } })
    expect(sendButton).toBeDisabled()

    fireEvent.change(message, { target: { value: 'x'.repeat(100_001) } })
    expect(screen.getByRole('alert')).toHaveTextContent('100,000 character limit')
    expect(sendButton).toBeDisabled()
  })

  it('disables conflicting actions while running and sends Stop through the transcript API', async () => {
    const abortRequest = deferred<void>()
    const abort = vi.fn(() => abortRequest.promise)
    installComposerApi({ abort })
    const transcript: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 2,
      sessionId: 'session-one',
      status: 'running'
    }
    const view = render(<TaskComposer sessionId="session-one" transcript={transcript} />)

    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add attachment' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Approval mode:/ })).toBeDisabled()
    expect(await screen.findByRole('button', { name: /Select model:/ })).toBeDisabled()
    const stop = screen.getByRole('button', { name: 'Stop generation' })
    fireEvent.click(stop)

    await waitFor(() => expect(abort).toHaveBeenCalledWith('session-one'))
    expect(stop).toHaveAttribute('aria-busy', 'true')

    await act(async () => abortRequest.resolve())
    expect(stop).toHaveAttribute('aria-busy', 'true')

    view.rerender(
      <TaskComposer sessionId="session-one" transcript={{ ...transcript, status: 'ready' }} />
    )
    expect(screen.getByRole('button', { name: 'Send message' })).not.toHaveAttribute('aria-busy')
  })

  it('attaches selected files and folders once and lets the user remove them', async () => {
    const file = { kind: 'file', name: 'notes.txt', path: '/tmp/notes.txt' } as const
    const folder = { kind: 'folder', name: 'project', path: '/tmp/project' } as const
    const pick = vi
      .fn<() => Promise<readonly ComposerAttachment[]>>()
      .mockResolvedValueOnce([file, folder])
      .mockResolvedValueOnce([file])
    installComposerApi({ pick })
    render(<TaskComposer />)

    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }))

    expect(await screen.findByRole('button', { name: 'Remove file notes.txt' })).toHaveAttribute(
      'title',
      file.path
    )
    expect(screen.getByRole('button', { name: 'Remove folder project' })).toHaveAttribute(
      'title',
      folder.path
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }))
    expect(await screen.findAllByText(file.name)).toHaveLength(1)

    const fileChip = screen.getByText(file.name).closest('li')
    fireEvent.click(screen.getByRole('button', { name: 'Remove file notes.txt' }))
    expect(fileChip).toHaveAttribute('data-present', 'false')
    expect(screen.getByText(file.name)).toBeInTheDocument()

    fireEvent.transitionEnd(fileChip!, { propertyName: 'opacity' })
    expect(screen.queryByText(file.name)).not.toBeInTheDocument()
    expect(screen.getByText(folder.name)).toBeInTheDocument()
    expect(pick).toHaveBeenCalledTimes(2)
  })

  it('keeps existing attachments when picking is cancelled and reports picker failures', async () => {
    const file = { kind: 'file', name: 'notes.txt', path: '/tmp/notes.txt' } as const
    const pick = vi
      .fn<() => Promise<readonly ComposerAttachment[]>>()
      .mockResolvedValueOnce([file])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('dialog failed'))
      .mockResolvedValueOnce([])
    installComposerApi({ pick })
    render(<TaskComposer />)
    const addAttachment = screen.getByRole('button', { name: 'Add attachment' })

    fireEvent.click(addAttachment)
    expect(await screen.findByText(file.name)).toBeInTheDocument()

    fireEvent.click(addAttachment)
    expect(await screen.findByText(file.name)).toBeInTheDocument()

    fireEvent.click(addAttachment)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not add attachments. Try again.')
    expect(alert).toHaveAttribute('data-present', 'true')
    expect(screen.getByText(file.name)).toBeInTheDocument()

    fireEvent.click(addAttachment)
    expect(alert).toHaveAttribute('data-present', 'false')
    expect(alert).toBeInTheDocument()

    fireEvent.transitionEnd(alert, { propertyName: 'opacity' })
    expect(alert).not.toBeInTheDocument()
  })

  it('loads, presents, and persists the desktop approval modes', async () => {
    const configuredApproval: ApprovalConfiguration = {
      mode: 'smart',
      reviewerModelId: 'reviewer'
    }
    const setMode = vi.fn<ApprovalApi['setMode']>(async (mode) => ({
      ...configuredApproval,
      mode
    }))
    installComposerApi({
      getApproval: async () => configuredApproval,
      setApprovalMode: setMode
    })
    render(<TaskComposer />)
    const approval = await screen.findByRole('button', {
      name: 'Approval mode: Approve for me'
    })
    expect(approval).toBeEnabled()

    fireEvent.pointerDown(approval, { button: 0, ctrlKey: false })

    const approveForMe = screen.getByRole('menuitemradio', { name: /Approve for me/ })
    expect(approveForMe).toHaveAttribute('data-state', 'checked')
    expect(approveForMe).toHaveTextContent('review protected actions')
    expect(screen.getByRole('menuitemradio', { name: /Ask for approval/ })).toHaveTextContent(
      'Confirm protected actions'
    )
    const fullAccess = screen.getByRole('menuitemradio', { name: /Full access/ })
    expect(fullAccess).toHaveTextContent('Run protected actions')
    fireEvent.click(fullAccess)

    await waitFor(() => expect(setMode).toHaveBeenCalledWith('off'))
    expect(screen.getByRole('button', { name: 'Approval mode: Full access' })).toBeInTheDocument()
  })

  it('keeps the persisted mode when an update fails or auto approval lacks a reviewer', async () => {
    const setMode = vi.fn<ApprovalApi['setMode']>(async () => {
      throw new Error('backend rejected')
    })
    installComposerApi({ setApprovalMode: setMode })
    render(<TaskComposer />)
    const approval = screen.getByRole('button', {
      name: 'Approval mode: Ask for approval'
    })
    await waitFor(() => expect(approval).toBeEnabled())

    fireEvent.pointerDown(approval, { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Approve for me/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose an approval model before enabling auto approval.'
    )
    expect(setMode).not.toHaveBeenCalled()
    expect(approval).toHaveAccessibleName('Approval mode: Ask for approval')

    fireEvent.pointerDown(approval, { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Full access/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update approval mode. Try again.'
    )
    expect(approval).toHaveAccessibleName('Approval mode: Ask for approval')
  })

  it('loads the available models and applies a selection to this and future tasks', async () => {
    const onSessionChanged = vi.fn()
    const select = vi.fn<ModelApi['select']>(async (modelId) => ({
      ...defaultModelConfiguration,
      activeSessionId: 'fork-session-one',
      activeModelId: modelId,
      defaultModelId: modelId
    }))
    installComposerApi({ selectModel: select })
    render(<TaskComposer onSessionChanged={onSessionChanged} sessionId="session-one" />)
    const trigger = await screen.findByRole('button', { name: 'Select model: GPT-5' })

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })

    expect(screen.getByRole('menuitemradio', { name: 'GPT-5' })).toHaveAttribute(
      'data-state',
      'checked'
    )
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Claude Sonnet' }))

    await waitFor(() => expect(select).toHaveBeenCalledWith('claude-sonnet'))
    expect(onSessionChanged).toHaveBeenCalledWith('fork-session-one')
    expect(screen.getByRole('button', { name: 'Select model: Claude Sonnet' })).toBeInTheDocument()
  })

  it('keeps a successful active-model change visible when saving the default warns', async () => {
    installComposerApi({
      selectModel: async () => ({
        ...defaultModelConfiguration,
        activeModelId: 'claude-sonnet',
        warning: 'This task changed to Claude Sonnet, but the default was not saved.'
      })
    })
    render(<TaskComposer />)
    const trigger = await screen.findByRole('button', { name: 'Select model: GPT-5' })

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Claude Sonnet' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This task changed to Claude Sonnet, but the default was not saved.'
    )
    expect(screen.getByRole('button', { name: 'Select model: Claude Sonnet' })).toBeInTheDocument()
  })
})
