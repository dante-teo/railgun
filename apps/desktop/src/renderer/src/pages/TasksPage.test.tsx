import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { emptyActivitySnapshot } from '@/lib/activity-api'
import type { ComposerAttachment } from '@/lib/attachment-api'
import { emptyContextUsageSnapshot } from '@/lib/context-usage-api'
import type { ModelConfiguration } from '@/lib/model-api'
import type { TaskSummary } from '@/lib/task-api'
import {
  emptyTranscriptSnapshot,
  type TranscriptApi,
  type TranscriptSnapshot,
  type TranscriptUpdate
} from '@/lib/transcript-api'
import { TasksPage } from '@/pages/TasksPage'

interface Deferred<Value> {
  promise: Promise<Value>
  reject: (reason?: unknown) => void
  resolve: (value: Value) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const tasks: TaskSummary[] = [
  { id: 'first', title: 'First task', lastMessageAt: '2026-08-09T01:00:00.000Z' },
  { id: 'second', title: 'Second task', lastMessageAt: '2026-08-08T01:00:00.000Z' },
  { id: 'third', title: 'Third task', lastMessageAt: '2026-08-07T01:00:00.000Z' }
]

const modelConfiguration: ModelConfiguration = {
  activeSessionId: 'first',
  activeModelId: 'mock-model',
  defaultModelId: 'mock-model',
  isRunning: false,
  models: [
    { id: 'mock-model', name: 'Mock Model' },
    { id: 'mock-reference', name: 'Mock Reference' }
  ],
  warning: null
}

function installTaskApi(
  list: () => Promise<TaskSummary[]>,
  archive: (sessionId: string) => Promise<void> = async () => undefined,
  open: (sessionId: string) => Promise<void> = async () => undefined,
  pickAttachments: () => Promise<readonly ComposerAttachment[]> = async () => [],
  transcriptApi: Partial<TranscriptApi> = {},
  create: () => Promise<string> = async () => 'new-session',
  selectModel: (modelId: string) => Promise<ModelConfiguration> = async (modelId) => ({
    ...modelConfiguration,
    activeModelId: modelId,
    defaultModelId: modelId
  })
): void {
  Object.defineProperty(window, 'railgun', {
    configurable: true,
    value: {
      activity: {
        getSnapshot: async () => emptyActivitySnapshot(),
        subscribe: () => () => undefined
      },
      attachments: { pick: pickAttachments },
      approval: {
        get: async () => ({ mode: 'manual', reviewerModelId: null }),
        setMode: async (mode: 'manual' | 'smart' | 'off') => ({
          mode,
          reviewerModelId: null
        })
      },
      contextUsage: {
        getSnapshot: async () => emptyContextUsageSnapshot(),
        subscribe: () => () => undefined
      },
      models: {
        get: async () => modelConfiguration,
        select: selectModel
      },
      tasks: { archive, create, list, open },
      transcript: {
        abort: async () => undefined,
        getSnapshot: async () => emptyTranscriptSnapshot(),
        respondToApproval: async () => undefined,
        respondToClarification: async () => undefined,
        send: async () => undefined,
        subscribe: () => () => undefined,
        ...transcriptApi
      }
    }
  })
}

function renderTasksPage(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <TasksPage />
    </TooltipProvider>
  )
}

async function renderPopulatedPage(
  archive: (sessionId: string) => Promise<void>,
  open: (sessionId: string) => Promise<void> = async () => undefined,
  pickAttachments: () => Promise<readonly ComposerAttachment[]> = async () => []
): Promise<void> {
  installTaskApi(async () => tasks, archive, open, pickAttachments)
  renderTasksPage()
  await screen.findByRole('button', { name: 'Select First task' })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('TasksPage', () => {
  it('owns loading, empty, and failure states for the backend list', async () => {
    const list = deferred<TaskSummary[]>()
    installTaskApi(() => list.promise)
    const view = renderTasksPage()
    expect(screen.getByRole('status', { name: 'Task list is loading' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    expect(
      await screen.findByRole('region', { name: 'Transcript for New Task' })
    ).toBeInTheDocument()

    await act(async () => list.resolve([]))
    expect(screen.getByText('No tasks yet')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Transcript for New Task' })).toBeInTheDocument()

    view.unmount()
    installTaskApi(async () => {
      throw new Error('backend unavailable')
    })
    renderTasksPage()
    expect(await screen.findByText('Tasks unavailable')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tasks.')
  })

  it('removes a task optimistically and serializes archive actions', async () => {
    const archiveRequest = deferred<void>()
    const archive = vi.fn(() => archiveRequest.promise)
    await renderPopulatedPage(archive)

    const firstRow = screen.getByRole('button', { name: 'Select First task' }).closest('li')
    fireEvent.click(screen.getByRole('button', { name: 'Archive First task' }))
    expect(screen.queryByRole('button', { name: 'Select First task' })).not.toBeInTheDocument()
    const secondArchive = screen.getByRole('button', { name: 'Archive Second task' })
    expect(secondArchive).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled()
    fireEvent.click(secondArchive)
    expect(archive).toHaveBeenCalledTimes(1)
    expect(archive).toHaveBeenCalledWith('first')

    await act(async () => archiveRequest.resolve())
    expect(secondArchive).toBeDisabled()
    fireEvent.transitionEnd(firstRow!, { propertyName: 'opacity' })
    expect(screen.queryByRole('button', { name: 'Select First task' })).not.toBeInTheDocument()
    await waitFor(() => expect(secondArchive).not.toBeDisabled())
    expect(screen.getByRole('button', { name: 'Create task' })).not.toBeDisabled()
  })

  it('restores a failed archive at its exact index and remains retry-safe', async () => {
    const archiveRequest = deferred<void>()
    const archive = vi.fn<(sessionId: string) => Promise<void>>()
    archive.mockReturnValueOnce(archiveRequest.promise).mockResolvedValueOnce(undefined)
    await renderPopulatedPage(archive)

    const secondRow = screen.getByRole('button', { name: 'Select Second task' }).closest('li')
    fireEvent.click(screen.getByRole('button', { name: 'Archive Second task' }))
    expect(screen.queryByRole('button', { name: 'Select Second task' })).not.toBeInTheDocument()
    fireEvent.transitionEnd(secondRow!, { propertyName: 'opacity' })

    await act(async () => archiveRequest.reject(new Error('rejected')))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not archive “Second task”. Try again.'
    )
    expect(
      screen
        .getAllByRole('button', { name: /^Select / })
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Select First task', 'Select Second task', 'Select Third task'])
    expect(screen.getByText('Second task').closest('li')).toHaveAttribute('data-restored', 'true')

    const restoredRow = screen.getByRole('button', { name: 'Select Second task' }).closest('li')
    fireEvent.click(screen.getByRole('button', { name: 'Archive Second task' }))
    expect(screen.queryByRole('button', { name: 'Select Second task' })).not.toBeInTheDocument()
    fireEvent.transitionEnd(restoredRow!, { propertyName: 'opacity' })
    await waitFor(() => expect(archive).toHaveBeenCalledTimes(2))
  })

  it('finishes a successful archive when the browser omits the transition event', async () => {
    await renderPopulatedPage(async () => undefined)
    vi.useFakeTimers()

    const secondArchive = screen.getByRole('button', { name: 'Archive Second task' })
    fireEvent.click(screen.getByRole('button', { name: 'Archive First task' }))
    expect(secondArchive).toBeDisabled()

    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })

    expect(screen.queryByText('First task')).not.toBeInTheDocument()
    expect(secondArchive).not.toBeDisabled()
  })

  it('does not replace a newer selection when a selected task is restored', async () => {
    const archiveRequest = deferred<void>()
    await renderPopulatedPage(() => archiveRequest.promise)

    fireEvent.click(screen.getByRole('button', { name: 'Select First task' }))
    const firstRow = screen.getByRole('button', { name: 'Select First task' }).closest('li')
    fireEvent.click(screen.getByRole('button', { name: 'Archive First task' }))
    fireEvent.transitionEnd(firstRow!, { propertyName: 'opacity' })
    fireEvent.click(screen.getByRole('button', { name: 'Select Second task' }))

    await act(async () => archiveRequest.reject(new Error('rejected')))

    expect(screen.getByRole('button', { name: 'Select First task' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByRole('button', { name: 'Select Second task' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('region', { name: 'Transcript for Second task' })).toBeInTheDocument()
  })

  it('shows an empty transcript until a task is selected, then renders its placeholder and composer controls', async () => {
    const open = vi.fn(async () => undefined)
    await renderPopulatedPage(async () => undefined, open)
    expect(screen.getByText('Select a task')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Select First task' }))

    expect(open).toHaveBeenCalledWith('first')
    expect(screen.getByRole('region', { name: 'Transcript for First task' })).toBeInTheDocument()
    expect(screen.queryByText('Transcript preview')).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Transcript is loading' })).toBeInTheDocument()
    const composer = screen.getByRole('group', { name: 'Message composer' })
    const composerQueries = within(composer)
    expect(composer).toBeInTheDocument()
    expect(composerQueries.getByRole('textbox', { name: 'Message' })).toHaveAttribute('rows', '1')
    const controls = within(composerQueries.getByRole('group', { name: 'Composer controls' }))
    expect(controls.getByRole('button', { name: 'Add attachment' })).toBeInTheDocument()
    expect(
      controls.getByRole('button', { name: 'Approval mode: Ask for approval' })
    ).toBeInTheDocument()
    expect(
      controls.getByRole('meter', { name: 'Context usage not measured yet' })
    ).toBeInTheDocument()
    expect(
      await controls.findByRole('button', { name: 'Select model: Mock Model' })
    ).toBeInTheDocument()
    expect(controls.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
  })

  it('does not carry attachments into another task composer', async () => {
    const attachment = {
      kind: 'folder',
      name: 'project',
      path: '/tmp/project'
    } as const
    await renderPopulatedPage(
      async () => undefined,
      async () => undefined,
      async () => [attachment]
    )

    fireEvent.click(screen.getByRole('button', { name: 'Select First task' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }))
    expect(await screen.findByText(attachment.name)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Select Second task' }))
    expect(screen.queryByText(attachment.name)).not.toBeInTheDocument()
  })

  it('reports a task-open failure without replacing a newer selection', async () => {
    const firstOpen = deferred<void>()
    const open = vi
      .fn<(sessionId: string) => Promise<void>>()
      .mockReturnValueOnce(firstOpen.promise)
      .mockResolvedValueOnce(undefined)
    await renderPopulatedPage(async () => undefined, open)

    fireEvent.click(screen.getByRole('button', { name: 'Select First task' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select Second task' }))
    await act(async () => firstOpen.reject(new Error('rejected')))

    expect(screen.queryByText(/Could not open/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select Second task' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('restores the active selection when a task-open attempt fails', async () => {
    const secondOpen = deferred<void>()
    const open = vi
      .fn<(sessionId: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(secondOpen.promise)
    await renderPopulatedPage(async () => undefined, open)

    fireEvent.click(screen.getByRole('button', { name: 'Select First task' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('first'))
    fireEvent.click(screen.getByRole('button', { name: 'Select Second task' }))
    await act(async () => secondOpen.reject(new Error('rejected')))

    expect(screen.getByRole('button', { name: 'Select First task' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Select Second task' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByRole('region', { name: 'Transcript for First task' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not open “Second task”. Try again.')
  })

  it('keeps task navigation disabled while the active transcript is running', async () => {
    const running: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: 'first',
      status: 'running'
    }
    installTaskApi(
      async () => tasks,
      async () => undefined,
      async () => undefined,
      async () => [],
      { getSnapshot: async () => running }
    )
    renderTasksPage()

    const first = await screen.findByRole('button', { name: 'Select First task' })
    await waitFor(() => expect(first).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Select Second task' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Archive First task' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled()
  })

  it('creates one unsaved task and shows its empty transcript without adding a saved row', async () => {
    const create = vi.fn(async () => 'new-session')
    const ready: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: 'new-session',
      status: 'ready'
    }
    installTaskApi(
      async () => tasks,
      async () => undefined,
      async () => undefined,
      async () => [],
      { getSnapshot: async () => ready },
      create
    )
    renderTasksPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Create task' }))

    expect(
      await screen.findByRole('region', { name: 'Transcript for New Task' })
    ).toBeInTheDocument()
    expect(screen.getByText('No messages yet')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Message composer' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select New Task' })).not.toBeInTheDocument()
    expect(create).toHaveBeenCalledOnce()
    for (const task of tasks) {
      expect(screen.getByRole('button', { name: `Select ${task.title}` })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    }
  })

  it('serializes task creation and disables conflicting task actions while it is pending', async () => {
    const createRequest = deferred<string>()
    const create = vi.fn(() => createRequest.promise)
    installTaskApi(
      async () => tasks,
      async () => undefined,
      async () => undefined,
      async () => [],
      {},
      create
    )
    renderTasksPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Select First task' }))
    const message = await screen.findByRole('textbox', { name: 'Message' })
    const createButton = await screen.findByRole('button', { name: 'Create task' })
    fireEvent.click(createButton)

    expect(createButton).toBeDisabled()
    expect(createButton).toHaveAttribute('aria-busy', 'true')
    expect(createButton).toHaveAttribute('data-creating', 'true')
    expect(message).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Select First task' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Archive First task' })).toBeDisabled()
    fireEvent.click(createButton)
    expect(create).toHaveBeenCalledOnce()

    await act(async () => createRequest.resolve('new-session'))
    expect(createButton).not.toBeDisabled()
    expect(createButton).not.toHaveAttribute('aria-busy')
    expect(createButton).not.toHaveAttribute('data-creating')
  })

  it('preserves the selected task and remains retryable when creation fails', async () => {
    const create = vi.fn(async () => {
      throw new Error('backend detail')
    })
    const ready: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: 'first',
      status: 'ready'
    }
    installTaskApi(
      async () => tasks,
      async () => undefined,
      async () => undefined,
      async () => [],
      { getSnapshot: async () => ready },
      create
    )
    renderTasksPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Select First task' }))
    expect(
      await screen.findByRole('region', { name: 'Transcript for First task' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not create a new task. Try again.'
    )
    expect(screen.getByRole('region', { name: 'Transcript for First task' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select First task' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
  })

  it('sends the first prompt through the unsaved session and selects its persisted summary', async () => {
    const persistedTask: TaskSummary = {
      id: 'new-session',
      title: 'Generated task title',
      lastMessageAt: '2026-08-11T02:00:00.000Z'
    }
    const list = vi.fn<() => Promise<TaskSummary[]>>()
    list.mockResolvedValueOnce(tasks).mockResolvedValueOnce([persistedTask, ...tasks])
    const send = vi.fn(async () => undefined)
    const ready: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: 'new-session',
      status: 'ready'
    }
    installTaskApi(
      list,
      async () => undefined,
      async () => undefined,
      async () => [],
      { getSnapshot: async () => ready, send },
      async () => 'new-session'
    )
    renderTasksPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Create task' }))
    const message = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(message, { target: { value: 'Build the report' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('new-session', {
        text: 'Build the report',
        attachments: []
      })
    )
    const persistedRow = await screen.findByRole('button', {
      name: 'Select Generated task title'
    })
    expect(persistedRow).toHaveAttribute('aria-pressed', 'true')
    expect(persistedRow.closest('li')).toHaveAttribute('data-newly-persisted', 'true')
    fireEvent.transitionEnd(persistedRow.closest('li')!, { propertyName: 'opacity' })
    await waitFor(() =>
      expect(persistedRow.closest('li')).not.toHaveAttribute('data-newly-persisted')
    )
    expect(persistedRow.closest('li')?.querySelector('time')).toHaveAttribute(
      'datetime',
      persistedTask.lastMessageAt
    )
    expect(
      screen.getByRole('region', { name: 'Transcript for Generated task title' })
    ).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('keeps an unsaved detail attached to a model-forked session ID', async () => {
    const transcriptListeners = new Set<(update: TranscriptUpdate) => void>()
    const send = vi.fn(async () => undefined)
    const ready: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: 'new-session',
      status: 'ready'
    }
    installTaskApi(
      async () => tasks,
      async () => undefined,
      async () => undefined,
      async () => [],
      {
        getSnapshot: async () => ready,
        send,
        subscribe: (listener) => {
          transcriptListeners.add(listener)
          return () => transcriptListeners.delete(listener)
        }
      },
      async () => 'new-session',
      async (modelId) => {
        const update = {
          revision: 2,
          snapshot: { ...ready, revision: 2, sessionId: 'forked-new-session' }
        }
        transcriptListeners.forEach((listener) => listener(update))
        return {
          ...modelConfiguration,
          activeModelId: modelId,
          activeSessionId: 'forked-new-session',
          defaultModelId: modelId
        }
      }
    )
    renderTasksPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Create task' }))
    const originalComposer = await screen.findByRole('group', { name: 'Message composer' })
    const model = await screen.findByRole('button', { name: 'Select model: Mock Model' })
    await waitFor(() => expect(model).toBeEnabled())
    fireEvent.keyDown(model, { code: 'Enter', key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Mock Reference' }))

    await waitFor(() => expect(originalComposer).not.toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Transcript for New Task' })).toBeInTheDocument()
    )
    expect(await screen.findByText('No messages yet')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled())
    const message = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(message, { target: { value: 'Use the new model' } })
    const sendButton = screen.getByRole('button', { name: 'Send message' })
    await waitFor(() => expect(sendButton).toBeEnabled())
    fireEvent.click(sendButton)

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('forked-new-session', {
        text: 'Use the new model',
        attachments: []
      })
    )
    expect(screen.queryByRole('button', { name: 'Select New Task' })).not.toBeInTheDocument()
  })

  it('keeps the unsaved detail visible when its post-save list refresh fails', async () => {
    const list = vi.fn<() => Promise<TaskSummary[]>>()
    list.mockResolvedValueOnce(tasks).mockRejectedValueOnce(new Error('offline'))
    const ready: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: 'new-session',
      status: 'ready'
    }
    installTaskApi(
      list,
      async () => undefined,
      async () => undefined,
      async () => [],
      { getSnapshot: async () => ready, send: async () => undefined },
      async () => 'new-session'
    )
    renderTasksPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Create task' }))
    const message = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(message, { target: { value: 'Persist me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The task was saved, but the task list could not be refreshed.'
    )
    expect(screen.getByRole('region', { name: 'Transcript for New Task' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select New Task' })).not.toBeInTheDocument()
  })

  it('refreshes page-owned task summaries after a prompt is saved', async () => {
    const refreshedTasks = [
      { ...tasks[0], title: 'Generated task title', lastMessageAt: '2026-08-10T02:00:00.000Z' },
      ...tasks.slice(1)
    ]
    const list = vi.fn<() => Promise<TaskSummary[]>>()
    list.mockResolvedValueOnce(tasks).mockResolvedValueOnce(refreshedTasks)
    const send = vi.fn(async () => undefined)
    const ready: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: 'first',
      status: 'ready'
    }
    installTaskApi(
      list,
      async () => undefined,
      async () => undefined,
      async () => [],
      {
        getSnapshot: async () => ready,
        send
      }
    )
    renderTasksPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Select First task' }))
    const message = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(message, { target: { value: 'Generate the report' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(send).toHaveBeenCalledWith('first', expect.any(Object)))
    expect(await screen.findByText('Generated task title')).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(2)
  })
})
