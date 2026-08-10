import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useActivity } from '@/hooks/use-activity'
import {
  emptyActivitySnapshot,
  type ActivitySnapshot,
  type ActivityUpdate
} from '@/lib/activity-api'

interface Deferred<Value> {
  promise: Promise<Value>
  resolve: (value: Value) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function ActivityRevision(): React.JSX.Element {
  const activity = useActivity()
  return <span>{activity.revision}</span>
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useActivity', () => {
  it('subscribes before loading, ignores a stale startup snapshot, and cleans up', async () => {
    const initial = deferred<ActivitySnapshot>()
    let listener: ((update: ActivityUpdate) => void) | undefined
    const unsubscribe = vi.fn()
    const calls: string[] = []
    Object.defineProperty(window, 'railgun', {
      configurable: true,
      value: {
        activity: {
          getSnapshot: () => {
            calls.push('snapshot')
            return initial.promise
          },
          subscribe: (nextListener: (update: ActivityUpdate) => void) => {
            calls.push('subscribe')
            listener = nextListener
            return unsubscribe
          }
        },
        tasks: {
          archive: async () => undefined,
          list: async () => [],
          open: async () => undefined
        }
      }
    })

    const view = render(<ActivityRevision />)
    expect(calls).toEqual(['subscribe', 'snapshot'])

    await act(async () => {
      listener?.({
        revision: 2,
        snapshot: { ...emptyActivitySnapshot(), revision: 2, subagentCount: 1 }
      })
      initial.resolve({ ...emptyActivitySnapshot(), revision: 1 })
      await initial.promise
    })
    expect(screen.getByText('2')).toBeInTheDocument()

    act(() => {
      listener?.({
        revision: 3,
        snapshot: { ...emptyActivitySnapshot(), revision: 2 }
      })
    })
    expect(screen.getByText('2')).toBeInTheDocument()

    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
