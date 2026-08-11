import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '@/App'
import { emptyActivitySnapshot } from '@/lib/activity-api'
import { emptyContextUsageSnapshot } from '@/lib/context-usage-api'
import type { ModelConfiguration } from '@/lib/model-api'
import type { ArchivedTaskSummary } from '@/lib/task-api'
import { emptyTranscriptSnapshot } from '@/lib/transcript-api'
import { DEFAULT_SHELL_LAYOUT, SHELL_LAYOUT_STORAGE_KEY } from '@/layouts/app-shell-storage'

const modelConfiguration: ModelConfiguration = {
  activeSessionId: 'active',
  activeModelId: 'model-one',
  defaultModelId: 'model-one',
  isRunning: false,
  models: [
    { id: 'model-one', name: 'Model One' },
    { id: 'model-two', name: 'Model Two' }
  ],
  warning: null
}

function installApi({
  archivedTasks = [],
  deleteAllArchived = async () => 0,
  deleteArchived = async () => undefined,
  running = false,
  setSoul = async (content: string) => content
}: {
  archivedTasks?: readonly ArchivedTaskSummary[]
  deleteAllArchived?: () => Promise<number>
  deleteArchived?: (taskId: string) => Promise<void>
  running?: boolean
  setSoul?: (content: string) => Promise<string>
} = {}): void {
  const models = { ...modelConfiguration, isRunning: running }
  Object.defineProperty(window, 'railgun', {
    configurable: true,
    value: {
      activity: {
        getSnapshot: async () => emptyActivitySnapshot(),
        subscribe: () => () => undefined
      },
      advisor: {
        get: async () => ({ enabled: false, modelId: 'model-two' }),
        set: async (configuration: unknown) => configuration
      },
      approval: {
        get: async () => ({ mode: 'manual', reviewerModelId: null }),
        set: async (configuration: unknown) => configuration,
        setMode: async (mode: string) => ({ mode, reviewerModelId: null })
      },
      attachments: { pick: async () => [] },
      contextUsage: {
        getSnapshot: async () => emptyContextUsageSnapshot(),
        subscribe: () => () => undefined
      },
      models: {
        get: async () => models,
        select: async () => models,
        setDefault: async (defaultModelId: string | null) => ({ ...models, defaultModelId })
      },
      personalization: {
        soul: { get: async () => '# Original', set: setSoul },
        memories: {
          list: async () => [],
          create: async (input: { content: string; category: string }) => ({
            id: 'created',
            ...input,
            createdAt: 1
          }),
          update: async (id: string, input: { content: string; category: string }) => ({
            id,
            ...input,
            createdAt: 1
          }),
          delete: async () => undefined
        }
      },
      scheduler: {
        getStatus: async () => ({ state: 'not-installed', detail: null }),
        install: async () => ({ state: 'running', detail: null }),
        uninstall: async () => ({ state: 'not-installed', detail: null })
      },
      skills: {
        list: async () => [],
        get: async () => ({
          name: 'review',
          description: 'Review',
          body: '',
          allowModelInvocation: true
        }),
        create: async (input: unknown) => input,
        update: async (_name: string, input: Record<string, unknown>) => ({
          name: 'review',
          ...input
        }),
        delete: async () => undefined
      },
      tasks: {
        archive: async () => undefined,
        create: async () => 'new',
        deleteAllArchived,
        deleteArchived,
        list: async () => [],
        listArchived: async () => archivedTasks,
        open: async () => undefined,
        unarchive: async () => undefined
      },
      transcript: {
        abort: async () => undefined,
        getSnapshot: async () => emptyTranscriptSnapshot(),
        respondToApproval: async () => undefined,
        respondToClarification: async () => undefined,
        send: async () => undefined,
        subscribe: () => () => undefined
      }
    }
  })
}

function renderApp(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  installApi()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Settings routes', () => {
  it('redirects /settings to General and preserves the content-detail split without Inspector', async () => {
    renderApp('/settings')
    expect(await screen.findByRole('heading', { name: 'General' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page')
    expect(document.querySelector('#shell-content')).toBeInTheDocument()
    expect(document.querySelector('#shell-detail')).toBeInTheDocument()
    expect(document.querySelector('#shell-inspector')).toBeNull()
    expect(document.querySelector('[data-shell-topbar="inspector"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /inspector/i })).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: 'Appearance' }))
    expect(await screen.findByRole('heading', { name: 'Appearance' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Appearance' })).toHaveAttribute('aria-current', 'page')
  })

  it('restores the stored Inspector preference when returning to Tasks', async () => {
    window.localStorage.setItem(
      SHELL_LAYOUT_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SHELL_LAYOUT, inspectorVisible: true })
    )
    renderApp('/settings/general')
    await screen.findByRole('heading', { name: 'General' })
    expect(document.querySelector('#shell-inspector')).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: 'Tasks' }))
    expect(await screen.findByText('No tasks yet')).toBeInTheDocument()
    expect(document.querySelector('#shell-inspector')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide inspector' })).toBeInTheDocument()
  })

  it('locks configuration controls during an active run but leaves scheduling available', async () => {
    installApi({ running: true })
    renderApp('/settings/general')
    expect(await screen.findByText('Model for future tasks')).toBeInTheDocument()
    expect(screen.getByLabelText('Model for future tasks')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Install' })).not.toBeDisabled()
    expect(screen.getByText(/locked while a task runs/i)).toBeInTheDocument()
  })

  it('auto-saves a valid SOUL.md draft before category navigation', async () => {
    const setSoul = vi.fn(async (content: string) => content)
    installApi({ setSoul })
    renderApp('/settings/personalization')
    const editor = await screen.findByRole('textbox', { name: 'Personal instructions' })
    fireEvent.change(editor, { target: { value: '# Changed' } })
    fireEvent.click(screen.getByRole('link', { name: 'Appearance' }))

    await waitFor(() => expect(setSoul).toHaveBeenCalledWith('# Changed'))
    expect(await screen.findByRole('heading', { name: 'Appearance' })).toBeInTheDocument()
  })

  it('cancels navigation and retains the draft when auto-save fails', async () => {
    installApi({ setSoul: async () => Promise.reject(new Error('disk full')) })
    renderApp('/settings/personalization')
    const editor = await screen.findByRole('textbox', { name: 'Personal instructions' })
    fireEvent.change(editor, { target: { value: '# Unsaved' } })
    fireEvent.click(screen.getByRole('link', { name: 'Appearance' }))

    expect(await screen.findByText(/draft is still here/i)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Personalization' })).toBeInTheDocument()
    expect(editor).toHaveValue('# Unsaved')
  })

  it('keeps a confirmed archived-task removal mounted through its exit transition', async () => {
    const deleteArchived = vi.fn(async () => undefined)
    installApi({
      archivedTasks: [
        {
          archivedAt: '2026-08-12T00:00:00.000Z',
          id: 'task-archived',
          messageCount: 3,
          model: 'model-one',
          title: 'Archived task'
        }
      ],
      deleteArchived
    })
    renderApp('/settings/archived-tasks')
    const title = await screen.findByText('Archived task')
    const row = title.closest<HTMLElement>('[data-slot="settings-list-item"]')!

    fireEvent.click(within(row).getByRole('button', { name: 'Permanently delete Archived task' }))
    const confirmation = screen
      .getByText('Permanently delete “Archived task”?')
      .closest<HTMLElement>('[role="alertdialog"]')!
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleteArchived).toHaveBeenCalledWith('task-archived'))
    await waitFor(() => expect(row).toHaveAttribute('data-motion', 'exiting'))
    expect(row).toHaveAttribute('inert')
    expect(title).toBeInTheDocument()

    fireEvent.transitionEnd(row, { propertyName: 'opacity' })
    expect(screen.queryByText('Archived task')).not.toBeInTheDocument()
  })

  it('finishes Delete All when an archive search hides some rows', async () => {
    const deleteAllArchived = vi.fn(async () => 2)
    installApi({
      archivedTasks: [
        {
          archivedAt: '2026-08-12T00:00:00.000Z',
          id: 'task-visible',
          messageCount: 1,
          model: 'model-one',
          title: 'Visible task'
        },
        {
          archivedAt: '2026-08-11T00:00:00.000Z',
          id: 'task-hidden',
          messageCount: 1,
          model: 'model-two',
          title: 'Hidden task'
        }
      ],
      deleteAllArchived
    })
    renderApp('/settings/archived-tasks')
    const search = await screen.findByRole('searchbox', { name: 'Search archived tasks' })
    fireEvent.change(search, { target: { value: 'Visible' } })
    await waitFor(() => expect(screen.queryByText('Hidden task')).not.toBeInTheDocument())

    const deleteAllButton = screen.getByRole('button', { name: 'Delete All' })
    fireEvent.click(deleteAllButton)
    const confirmation = screen
      .getByText('Delete all 2 archived tasks?')
      .closest<HTMLElement>('[role="alertdialog"]')!
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete All' }))

    await waitFor(() => expect(deleteAllArchived).toHaveBeenCalledOnce())
    const visibleRow = screen
      .getByText('Visible task')
      .closest<HTMLElement>('[data-slot="settings-list-item"]')!
    await waitFor(() => expect(visibleRow).toHaveAttribute('data-motion', 'exiting'))
    fireEvent.transitionEnd(visibleRow, { propertyName: 'opacity' })

    expect(search).not.toBeDisabled()
    expect(screen.queryByText('Visible task')).not.toBeInTheDocument()
    expect(deleteAllButton).toBeDisabled()
  })
})
