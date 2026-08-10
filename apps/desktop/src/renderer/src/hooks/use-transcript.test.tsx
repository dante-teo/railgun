import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useTranscript } from '@/hooks/use-transcript'
import {
  emptyTranscriptSnapshot,
  type TranscriptSnapshot,
  type TranscriptUpdate
} from '@/lib/transcript-api'

function TranscriptRevision(): React.JSX.Element {
  return <span>{useTranscript().revision}</span>
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useTranscript', () => {
  it('subscribes before loading, keeps the newest consistent revision, and cleans up', async () => {
    let resolveSnapshot!: (snapshot: TranscriptSnapshot) => void
    const snapshot = new Promise<TranscriptSnapshot>((resolve) => {
      resolveSnapshot = resolve
    })
    let listener: ((update: TranscriptUpdate) => void) | undefined
    const unsubscribe = vi.fn()
    Object.defineProperty(window, 'railgun', {
      configurable: true,
      value: {
        transcript: {
          getSnapshot: () => snapshot,
          subscribe: (nextListener: (update: TranscriptUpdate) => void) => {
            listener = nextListener
            return unsubscribe
          },
          send: async () => undefined,
          abort: async () => undefined
        }
      }
    })

    const view = render(<TranscriptRevision />)
    await act(async () => {
      listener?.({
        revision: 2,
        snapshot: { ...emptyTranscriptSnapshot(), revision: 2 }
      })
      resolveSnapshot({ ...emptyTranscriptSnapshot(), revision: 1 })
      await snapshot
    })
    expect(screen.getByText('2')).toBeInTheDocument()

    act(() => {
      listener?.({
        revision: 3,
        snapshot: { ...emptyTranscriptSnapshot(), revision: 2 }
      })
    })
    expect(screen.getByText('2')).toBeInTheDocument()

    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
