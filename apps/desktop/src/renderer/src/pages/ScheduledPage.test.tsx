import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '@/App'
import { emptyActivitySnapshot } from '@/lib/activity-api'
import type {
  ScheduledJob,
  ScheduledJobCreateInput,
  ScheduledJobInput,
  SchedulerStatus
} from '@/lib/scheduler-api'
import { DEFAULT_SHELL_LAYOUT, SHELL_LAYOUT_STORAGE_KEY } from '@/layouts/app-shell-storage'

const job = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  name: 'morning-brief',
  schedule: '0 9 * * 1-5',
  prompt: 'Prepare the morning brief',
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  ...overrides
})

function installApi({
  createJob = async (input: ScheduledJobCreateInput) => job(input),
  deleteJob = async () => undefined,
  getStatus = async () => ({ state: 'running', detail: null }) as SchedulerStatus,
  listJobs = async () => [],
  updateJob = async (name: string, input: ScheduledJobInput) => job({ name, ...input })
}: {
  createJob?: (input: ScheduledJobCreateInput) => Promise<ScheduledJob>
  deleteJob?: (name: string) => Promise<void>
  getStatus?: () => Promise<SchedulerStatus>
  listJobs?: () => Promise<readonly ScheduledJob[]>
  updateJob?: (name: string, input: ScheduledJobInput) => Promise<ScheduledJob>
} = {}): void {
  Object.defineProperty(window, 'railgun', {
    configurable: true,
    value: {
      activity: {
        getSnapshot: async () => emptyActivitySnapshot(),
        subscribe: () => () => undefined
      },
      scheduler: {
        createJob,
        deleteJob,
        getStatus,
        install: async () => ({ state: 'running', detail: null }),
        listJobs,
        uninstall: async () => ({ state: 'not-installed', detail: null }),
        updateJob
      }
    }
  })
}

function renderScheduled(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/scheduled']}>
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

describe('Scheduled route', () => {
  it('selects Scheduled and fills the Workspace without Detail or Inspector', async () => {
    window.localStorage.setItem(
      SHELL_LAYOUT_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SHELL_LAYOUT, inspectorVisible: true })
    )
    renderScheduled()

    expect(await screen.findByRole('heading', { name: 'Scheduled Jobs' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Scheduled' })).toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByText('Scheduled', { selector: '[data-shell-topbar="workspace"] *' })
    ).toBeInTheDocument()
    expect(document.querySelector('#shell-content')).toHaveAttribute('data-fills-workspace', 'true')
    expect(document.querySelector('#shell-detail')).toBeNull()
    expect(document.querySelector('#shell-inspector')).toBeNull()
    expect(screen.queryByRole('button', { name: /inspector/i })).toBeNull()
    expect(
      JSON.parse(window.localStorage.getItem(SHELL_LAYOUT_STORAGE_KEY)!).inspectorVisible
    ).toBe(true)
  })

  it('shows loading, retry, and empty states without coupling scheduler status', async () => {
    let resolveJobs!: (jobs: readonly ScheduledJob[]) => void
    const listJobs = vi
      .fn<() => Promise<readonly ScheduledJob[]>>()
      .mockImplementationOnce(
        () => new Promise<readonly ScheduledJob[]>((resolve) => (resolveJobs = resolve))
      )
    installApi({
      getStatus: async () => ({ state: 'not-installed', detail: null }),
      listJobs
    })
    renderScheduled()

    const loading = screen.getByRole('status', { name: 'Scheduled jobs are loading' })
    const loadingLayer = loading.closest<HTMLElement>('[data-slot="crossfade-layer"]')!
    expect(await screen.findByText('Background scheduling is not running')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open General Settings' })).toHaveAttribute(
      'href',
      '/settings/general'
    )

    resolveJobs([])
    const emptyTitle = await screen.findByText('No schedules yet')
    const emptyLayer = emptyTitle.closest<HTMLElement>('[data-slot="crossfade-layer"]')!
    expect(loadingLayer).toHaveAttribute('aria-hidden', 'true')
    expect(loadingLayer).toHaveAttribute('data-motion', 'exiting')
    expect(loadingLayer).toHaveAttribute('inert')
    expect(emptyLayer).toHaveAttribute('data-motion', 'entering')
    fireEvent.transitionEnd(loadingLayer, { propertyName: 'opacity' })
    expect(loadingLayer).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New Schedule' })).toHaveLength(2)
  })

  it('retries an independent job-list failure', async () => {
    const listJobs = vi
      .fn<() => Promise<readonly ScheduledJob[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([])
    installApi({ listJobs })
    renderScheduled()

    expect(await screen.findByText('Could not load scheduled jobs')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No schedules yet')).toBeInTheDocument()
    expect(listJobs).toHaveBeenCalledTimes(2)
  })

  it('keeps CRUD available when scheduler status cannot be checked', async () => {
    installApi({ getStatus: async () => Promise.reject(new Error('launchctl unavailable')) })
    renderScheduled()

    expect(
      await screen.findByText('Background scheduling status is unavailable')
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New Schedule' })[0]).toBeEnabled()
  })

  it('retains the scheduler notice through its exit transition', async () => {
    const getStatus = vi
      .fn<() => Promise<SchedulerStatus>>()
      .mockRejectedValueOnce(new Error('launchctl unavailable'))
      .mockResolvedValueOnce({ state: 'running', detail: null })
    installApi({ getStatus })
    renderScheduled()

    const message = await screen.findByText('Background scheduling status is unavailable')
    const notice = message.closest<HTMLElement>('[data-slot="scheduler-notice"]')!
    fireEvent.click(screen.getByRole('button', { name: 'Retry status' }))

    await waitFor(() => expect(notice).toHaveAttribute('data-present', 'false'))
    expect(notice).toHaveAttribute('aria-hidden', 'true')
    expect(notice).toHaveAttribute('inert')
    expect(message).toBeInTheDocument()

    fireEvent.transitionEnd(notice, { propertyName: 'opacity' })
    expect(message).not.toBeInTheDocument()
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it('refreshes run metadata while mounted without showing the loading state again', async () => {
    let refresh: TimerHandler | undefined
    vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout) => {
      if (timeout === 30_000) refresh = handler
      return 1 as unknown as ReturnType<typeof window.setInterval>
    })
    const listJobs = vi
      .fn<() => Promise<readonly ScheduledJob[]>>()
      .mockResolvedValueOnce([job()])
      .mockResolvedValueOnce([
        job({
          lastRunAt: '2026-08-12T03:00:00.000Z',
          lastStatus: 'completed'
        })
      ])
    installApi({ listJobs })
    renderScheduled()

    expect(await screen.findByText('Never run')).toBeInTheDocument()
    await act(async () => {
      if (typeof refresh === 'function') refresh()
      await Promise.resolve()
    })

    expect(await screen.findByText('Completed')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Scheduled jobs are loading' })).toBeNull()
    expect(listJobs).toHaveBeenCalledTimes(2)
  })

  it('validates create fields and creates the daily preset without refetching', async () => {
    const createJob = vi.fn(async (input: ScheduledJobCreateInput) => job(input))
    const listJobs = vi.fn(async () => [] as readonly ScheduledJob[])
    installApi({ createJob, listJobs })
    renderScheduled()
    await screen.findByText('No schedules yet')

    fireEvent.click(screen.getAllByRole('button', { name: 'New Schedule' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(screen.getByText('Use 1–64 lowercase letters, numbers, or hyphens.')).toBeInTheDocument()
    expect(screen.getByText('Enter a prompt for this schedule.')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'daily-brief' }
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: '  Prepare a daily brief  ' }
    })
    expect(
      screen.queryByText('Use 1–64 lowercase letters, numbers, or hyphens.')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Enter a prompt for this schedule.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))

    await waitFor(() =>
      expect(createJob).toHaveBeenCalledWith({
        name: 'daily-brief',
        schedule: '0 9 * * *',
        prompt: 'Prepare a daily brief'
      })
    )
    expect(await screen.findByText('daily-brief')).toBeInTheDocument()
    expect(listJobs).toHaveBeenCalledOnce()
  })

  it('marks only a newly created row as entering when a list is already visible', async () => {
    const createJob = vi.fn(async (input: ScheduledJobCreateInput) => job(input))
    installApi({ createJob, listJobs: async () => [job({ name: 'existing-job' })] })
    renderScheduled()

    const existingName = await screen.findByText('existing-job')
    const existingRow = existingName.closest<HTMLElement>('[data-slot="scheduled-job-row"]')!
    expect(existingRow).toHaveAttribute('data-motion', 'stable')

    fireEvent.click(screen.getByRole('button', { name: 'New Schedule' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'new-job' }
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'Run the new job' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))

    const newName = await screen.findByText('new-job')
    expect(newName.closest('[data-slot="scheduled-job-row"]')).toHaveAttribute(
      'data-motion',
      'entering'
    )
    expect(existingRow).toHaveAttribute('data-motion', 'stable')
  })

  it('validates a custom schedule inline and previews its next local run', async () => {
    const user = userEvent.setup()
    const createJob = vi.fn(async (input: ScheduledJobCreateInput) => job(input))
    installApi({ createJob })
    renderScheduled()
    await screen.findByText('No schedules yet')
    await user.click(screen.getAllByRole('button', { name: 'New Schedule' })[0])
    await user.click(screen.getByRole('combobox', { name: 'Frequency' }))
    await user.click(await screen.findByRole('option', { name: 'Custom' }))

    let schedule = screen.getByRole('textbox', { name: 'Cron expression' })
    const customField = schedule.closest<HTMLElement>('[data-slot="scheduled-custom-field"]')!
    expect(customField).toHaveAttribute('data-motion', 'entering')
    expect(customField).toHaveClass('transition-[opacity,translate]')
    expect(customField).toHaveClass('motion-reduce:translate-none!')

    await user.click(screen.getByRole('combobox', { name: 'Frequency' }))
    await user.click(await screen.findByRole('option', { name: 'Hourly' }))
    expect(customField).toHaveAttribute('aria-hidden', 'true')
    expect(customField).toHaveAttribute('data-motion', 'exiting')
    expect(customField).toHaveAttribute('inert')
    fireEvent.transitionEnd(customField, { propertyName: 'opacity' })
    expect(customField).not.toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Frequency' }))
    await user.click(await screen.findByRole('option', { name: 'Custom' }))
    schedule = screen.getByRole('textbox', { name: 'Cron expression' })
    await user.clear(schedule)
    await user.type(schedule, '60 * * * *')
    expect(screen.getByText('Enter a valid five-field cron expression.')).toBeInTheDocument()

    await user.clear(schedule)
    await user.type(schedule, '15 10 * * *')
    expect(screen.queryByText('Enter a valid five-field cron expression.')).not.toBeInTheDocument()
    expect(screen.getByText(/Next due:/)).toBeInTheDocument()
    expect(screen.getAllByText(/Mac’s local time/)).toHaveLength(2)

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'custom-brief')
    await user.type(screen.getByRole('textbox', { name: 'Prompt' }), 'Custom prompt')
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await waitFor(() =>
      expect(createJob).toHaveBeenCalledWith({
        name: 'custom-brief',
        prompt: 'Custom prompt',
        schedule: '15 10 * * *'
      })
    )
  })

  it('keeps a failed save open with its draft intact', async () => {
    installApi({ createJob: async () => Promise.reject(new Error('store locked')) })
    renderScheduled()
    await screen.findByText('No schedules yet')
    fireEvent.click(screen.getAllByRole('button', { name: 'New Schedule' })[0])
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'daily-brief' }
    })
    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.change(prompt, { target: { value: 'Keep this draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))

    expect(await screen.findByText(/draft is still here/i)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(prompt).toHaveValue('Keep this draft')
  })

  it('edits a legacy-name job immutably and keeps its name fixed', async () => {
    const original = job({ name: 'Legacy Job ID' })
    const updateJob = vi.fn(async (name: string, input: ScheduledJobInput) =>
      job({ ...original, name, ...input })
    )
    const listJobs = vi.fn(async () => [original])
    installApi({ listJobs, updateJob })
    renderScheduled()
    await screen.findByText('Legacy Job ID')

    fireEvent.click(screen.getByRole('button', { name: 'Edit Legacy Job ID' }))
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'Updated prompt' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateJob).toHaveBeenCalledOnce())
    expect(await screen.findByText('Updated prompt')).toBeInTheDocument()
    expect(screen.queryByText('Prepare the morning brief')).not.toBeInTheDocument()
    expect(updateJob).toHaveBeenCalledWith('Legacy Job ID', {
      schedule: '0 9 * * 1-5',
      prompt: 'Updated prompt'
    })
    expect(listJobs).toHaveBeenCalledOnce()
  })

  it('keeps delete confirmation open on failure, then makes a deleted row inert through exit', async () => {
    const deleteJob = vi
      .fn<(name: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValueOnce(undefined)
    installApi({ deleteJob, listJobs: async () => [job()] })
    renderScheduled()
    const name = await screen.findByText('morning-brief')
    const row = name.closest<HTMLElement>('[data-slot="scheduled-job-row"]')!

    fireEvent.click(within(row).getByRole('button', { name: 'Delete morning-brief' }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('Delete “morning-brief”?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete schedule' }))
    expect(await within(dialog).findByText(/could not be deleted/i)).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete schedule' }))
    await waitFor(() => expect(row).toHaveAttribute('data-motion', 'exiting'))
    expect(row).toHaveAttribute('inert')
    expect(name).toBeInTheDocument()
    fireEvent.transitionEnd(row, { propertyName: 'opacity' })
    expect(screen.queryByText('morning-brief')).not.toBeInTheDocument()
  })

  it('renders compatible textual run statuses, bounded failures, times, and labelled actions', async () => {
    installApi({
      listJobs: async () => [
        job({ name: 'd-recorded', lastRunAt: '2026-08-12T03:00:00.000Z' }),
        job({
          name: 'c-failed',
          lastRunAt: '2026-08-12T02:00:00.000Z',
          lastStatus: 'failed',
          lastError: 'Provider unavailable'
        }),
        job({
          name: 'b-completed',
          lastRunAt: '2026-08-12T01:00:00.000Z',
          lastStatus: 'completed'
        }),
        job({ name: 'a-never' })
      ]
    })
    renderScheduled()

    expect(await screen.findByText('a-never')).toBeInTheDocument()
    for (const status of ['Never run', 'Completed', 'Failed', 'Run recorded']) {
      expect(screen.getByText(status)).toBeInTheDocument()
    }
    expect(screen.getByText('Provider unavailable')).toBeInTheDocument()
    expect(document.querySelectorAll('time').length).toBeGreaterThanOrEqual(7)
    expect(
      within(screen.getByRole('list', { name: 'Scheduled jobs' }))
        .getAllByRole('listitem')
        .map((row) => row.querySelector('p')?.textContent)
    ).toEqual(['a-never', 'b-completed', 'c-failed', 'd-recorded'])
    expect(screen.getByRole('button', { name: 'Edit c-failed' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete c-failed' })).toBeInTheDocument()
  })
})
