import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { TaskSummary } from '@/lib/task-api'
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

function installTaskApi(
  list: () => Promise<TaskSummary[]>,
  archive: (sessionId: string) => Promise<void> = async () => undefined
): void {
  Object.defineProperty(window, 'railgun', {
    configurable: true,
    value: { tasks: { archive, list } }
  })
}

function renderTasksPage(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <TasksPage />
    </TooltipProvider>
  )
}

async function renderPopulatedPage(archive: (sessionId: string) => Promise<void>): Promise<void> {
  installTaskApi(async () => tasks, archive)
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

    await act(async () => list.resolve([]))
    expect(screen.getByText('No tasks yet')).toBeInTheDocument()

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
    fireEvent.click(secondArchive)
    expect(archive).toHaveBeenCalledTimes(1)
    expect(archive).toHaveBeenCalledWith('first')

    await act(async () => archiveRequest.resolve())
    expect(secondArchive).toBeDisabled()
    fireEvent.transitionEnd(firstRow!, { propertyName: 'opacity' })
    expect(screen.queryByRole('button', { name: 'Select First task' })).not.toBeInTheDocument()
    await waitFor(() => expect(secondArchive).not.toBeDisabled())
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

  it('shows an empty transcript until a task is selected, then renders its placeholder', async () => {
    await renderPopulatedPage(async () => undefined)
    expect(screen.getByText('Select a task')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Select First task' }))

    expect(screen.getByRole('region', { name: 'Transcript for First task' })).toBeInTheDocument()
    expect(screen.getByText('Transcript preview')).toBeInTheDocument()
  })
})
