import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyContextUsageSnapshot } from '@/lib/context-usage-api'
import { emptyTranscriptSnapshot, type TranscriptSnapshot } from '@/lib/transcript-api'

const scrollToBottom = vi.fn(() => true)
let atBottom = true
let stickOptions: unknown

vi.mock('use-stick-to-bottom', () => ({
  useStickToBottom: (options: unknown) => {
    stickOptions = options
    return {
      contentRef: vi.fn(),
      isAtBottom: atBottom,
      scrollRef: vi.fn(),
      scrollToBottom
    }
  }
}))

import { TaskDetailPlaceholder } from './TaskDetailPlaceholder'

const task = {
  id: 'session-one',
  title: 'Session one',
  lastMessageAt: '2026-08-10T01:00:00.000Z'
}

function installApi(snapshot: TranscriptSnapshot, reducedMotion = false): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    })
  })
  Object.defineProperty(window, 'railgun', {
    configurable: true,
    value: {
      attachments: { pick: async () => [] },
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
        get: async () => ({
          activeSessionId: task.id,
          activeModelId: 'model-one',
          defaultModelId: 'model-one',
          isRunning: false,
          models: [{ id: 'model-one', name: 'Model One' }],
          warning: null
        }),
        select: async (modelId: string) => ({
          activeSessionId: task.id,
          activeModelId: modelId,
          defaultModelId: modelId,
          isRunning: false,
          models: [{ id: 'model-one', name: 'Model One' }],
          warning: null
        })
      },
      transcript: {
        abort: async () => undefined,
        getSnapshot: async () => snapshot,
        send: async () => undefined,
        subscribe: () => () => undefined
      }
    }
  })
}

function readySnapshot(): TranscriptSnapshot {
  return {
    ...emptyTranscriptSnapshot(),
    revision: 1,
    sessionId: task.id,
    status: 'ready',
    messages: [{ id: 'user-one', role: 'user', text: 'A message' }]
  }
}

beforeEach(() => {
  atBottom = true
  scrollToBottom.mockClear()
  stickOptions = undefined
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('task transcript scrolling', () => {
  it('anchors and follows growth instantly, then resumes following on submission', async () => {
    installApi(readySnapshot())
    render(<TaskDetailPlaceholder task={task} />)

    await screen.findByText('A message')
    expect(stickOptions).toEqual({ initial: 'instant', resize: 'instant' })

    scrollToBottom.mockClear()
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Continue' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(scrollToBottom).toHaveBeenCalledWith({
      animation: 'instant',
      ignoreEscapes: true
    })
  })

  it('shows a jump control after manual pause and uses a damped spring for an explicit jump', async () => {
    atBottom = false
    installApi(readySnapshot())
    const view = render(<TaskDetailPlaceholder task={task} />)
    await screen.findByText('A message')
    scrollToBottom.mockClear()

    const jump = screen.getByRole('button', { name: 'Jump to latest' })
    expect(jump).toHaveAttribute('data-present', 'true')
    fireEvent.click(jump)
    expect(scrollToBottom).toHaveBeenCalledWith({
      animation: expect.objectContaining({ damping: expect.any(Number), mass: 1, stiffness: 0.05 }),
      ignoreEscapes: true
    })

    atBottom = true
    view.rerender(<TaskDetailPlaceholder task={task} />)
    expect(jump).toHaveAttribute('data-present', 'false')

    atBottom = false
    view.rerender(<TaskDetailPlaceholder task={task} />)
    expect(jump).toHaveAttribute('data-present', 'true')

    atBottom = true
    view.rerender(<TaskDetailPlaceholder task={task} />)
    fireEvent.transitionEnd(jump, { propertyName: 'opacity' })
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument()
  })

  it('jumps instantly when reduced motion is requested', async () => {
    atBottom = false
    installApi(readySnapshot(), true)
    render(<TaskDetailPlaceholder task={task} />)
    await screen.findByText('A message')
    scrollToBottom.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(scrollToBottom).toHaveBeenCalledWith({
      animation: 'instant',
      ignoreEscapes: true
    })
  })
})
