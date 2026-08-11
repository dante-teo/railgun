import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TaskDetailPlaceholder } from '@/components/shell/TaskDetailPlaceholder'
import { emptyContextUsageSnapshot } from '@/lib/context-usage-api'
import {
  emptyTranscriptSnapshot,
  type TranscriptSnapshot,
  type TranscriptUpdate
} from '@/lib/transcript-api'
import type { TaskSummary } from '@/lib/task-api'

const task: TaskSummary = {
  id: 'session-one',
  title: 'A title that should not take transcript space',
  lastMessageAt: '2026-08-10T01:00:00.000Z'
}

function installApi(
  initialSnapshot: TranscriptSnapshot,
  responses: {
    respondToApproval?: (sessionId: string, requestId: string, approved: boolean) => Promise<void>
    respondToClarification?: (sessionId: string, requestId: string, answer: string) => Promise<void>
  } = {}
): {
  readonly emit: (snapshot: TranscriptSnapshot) => void
} {
  let listener: ((update: TranscriptUpdate) => void) | undefined
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
        getSnapshot: async () => initialSnapshot,
        respondToApproval: responses.respondToApproval ?? (async () => undefined),
        respondToClarification: responses.respondToClarification ?? (async () => undefined),
        send: async () => undefined,
        subscribe: (nextListener: (update: TranscriptUpdate) => void) => {
          listener = nextListener
          return () => {
            listener = undefined
          }
        }
      }
    }
  })
  return {
    emit: (snapshot) => listener?.({ revision: snapshot.revision, snapshot })
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TaskDetailPlaceholder', () => {
  it('keeps the unselected empty state and removes the selected-task header panel', async () => {
    installApi(emptyTranscriptSnapshot())
    const view = render(<TaskDetailPlaceholder />)
    expect(screen.getByText('Select a task')).toBeInTheDocument()

    view.rerender(<TaskDetailPlaceholder task={task} />)
    expect(screen.getByRole('region', { name: `Transcript for ${task.title}` })).toBeInTheDocument()
    expect(screen.queryByText(task.title)).not.toBeInTheDocument()
    expect(screen.queryByText('Transcript preview')).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Transcript is loading' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  })

  it('renders loading and safe error states for the selected task', async () => {
    const loading: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: task.id,
      status: 'loading'
    }
    const api = installApi(loading)
    render(<TaskDetailPlaceholder task={task} />)
    expect(await screen.findByRole('status', { name: 'Transcript is loading' })).toBeInTheDocument()

    await act(async () => {
      api.emit({
        ...loading,
        revision: 2,
        status: 'error',
        error: 'Could not load this transcript. Try reopening the task.'
      })
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load this transcript')
  })

  it('shows persistent working feedback for the whole active turn', async () => {
    const running: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: task.id,
      status: 'running',
      messages: [{ id: 'optimistic-user-one', role: 'user', text: 'Start now' }]
    }
    const api = installApi(running)
    render(<TaskDetailPlaceholder task={task} />)

    expect(await screen.findByRole('status', { name: 'Agent is working' })).toBeInTheDocument()

    await act(async () => {
      api.emit({
        ...running,
        revision: 2,
        status: 'ready',
        messages: [
          ...running.messages,
          { id: 'assistant-one', role: 'assistant', text: 'Done', status: 'complete' }
        ]
      })
    })
    expect(screen.queryByRole('status', { name: 'Agent is working' })).not.toBeInTheDocument()
  })

  it('keeps the final answer visible below a collapsed, expandable work summary', async () => {
    const snapshot: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: task.id,
      status: 'ready',
      messages: [
        {
          id: 'user-one',
          role: 'user',
          text: 'Prepare the release brief.',
          startedAt: 1_000
        },
        {
          id: 'tool-one',
          role: 'tool',
          name: 'read_file',
          detail: 'RELEASING.md',
          failed: false
        },
        {
          id: 'assistant-progress',
          role: 'assistant',
          text: 'I found the release checklist.',
          status: 'complete'
        },
        {
          id: 'assistant-final',
          role: 'assistant',
          text: 'The release brief is ready.',
          status: 'complete',
          completedAt: 208_000
        }
      ]
    }
    installApi(snapshot)
    render(<TaskDetailPlaceholder task={task} />)

    const transcript = await screen.findByRole('log', { name: 'Task transcript' })
    const disclosure = within(transcript).getByRole('button', {
      name: 'Worked for 3m 27s. Show work'
    })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(disclosure.querySelector('[data-completion-cue]')).toBeNull()
    const finalAnswer = within(transcript).getByText('The release brief is ready.')
    expect(finalAnswer).toBeInTheDocument()
    expect(finalAnswer.closest('[data-message-role="assistant"]')).not.toHaveAttribute(
      'data-completion-cue'
    )
    expect(within(transcript).queryByText('I found the release checklist.')).not.toBeInTheDocument()
    expect(within(transcript).queryByText('Explored')).not.toBeInTheDocument()
    const separator = transcript.querySelector('[data-slot="separator"]')
    expect(separator).not.toBeNull()
    expect(disclosure.nextElementSibling).toBe(separator)

    fireEvent.click(disclosure)

    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(disclosure).toHaveAccessibleName('Worked for 3m 27s. Hide work')
    expect(disclosure.nextElementSibling).toBe(separator)
    expect(within(transcript).getByText('I found the release checklist.')).toBeInTheDocument()
    expect(within(transcript).getByText('Explored')).toBeInTheDocument()
    expect(within(transcript).getByText('The release brief is ready.')).toBeInTheDocument()
  })

  it('automatically collapses active work when the end-turn answer arrives', async () => {
    const running: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: task.id,
      status: 'running',
      messages: [
        { id: 'optimistic-user-one', role: 'user', text: 'Inspect this.', startedAt: 1_000 },
        {
          id: 'tool-one',
          role: 'tool',
          name: 'railgun_inspect',
          detail: 'Configuration diagnostics',
          failed: false,
          running: true
        }
      ]
    }
    const api = installApi(running)
    render(<TaskDetailPlaceholder task={task} />)

    const activeDisclosure = await screen.findByRole('button', {
      name: 'Working… Hide work'
    })
    expect(activeDisclosure).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Explored')).toBeInTheDocument()
    expect(screen.getByText('Inspected Railgun')).toBeInTheDocument()

    await act(async () => {
      api.emit({
        ...running,
        revision: 2,
        status: 'ready',
        messages: [
          { id: 'message-41', role: 'user', text: 'Inspect this.', startedAt: 1_000 },
          {
            id: 'tool-one',
            role: 'tool',
            name: 'railgun_inspect',
            detail: 'Configuration diagnostics',
            failed: false
          },
          {
            id: 'assistant-final',
            role: 'assistant',
            text: 'Inspection finished.',
            status: 'complete',
            completedAt: 208_000
          }
        ]
      })
    })

    const completedDisclosure = screen.getByRole('button', {
      name: 'Worked for 3m 27s. Show work'
    })
    expect(completedDisclosure).toHaveAttribute('aria-expanded', 'false')
    expect(completedDisclosure.querySelector('[data-completion-cue="true"]')).not.toBeNull()
    expect(screen.queryByText('Inspected Railgun')).not.toBeInTheDocument()
    const finalAnswer = screen.getByText('Inspection finished.')
    expect(finalAnswer).toBeInTheDocument()
    expect(finalAnswer.closest('[data-message-role="assistant"]')).toHaveAttribute(
      'data-completion-cue',
      'true'
    )
  })

  it('surfaces approval and clarification requests while preserving Stop', async () => {
    const respondToApproval = vi.fn(async () => undefined)
    const respondToClarification = vi.fn(async () => undefined)
    const running: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: task.id,
      status: 'running',
      interactions: [
        {
          id: 'approval-one',
          type: 'approval',
          command: 'sudo safe-command',
          status: 'pending',
          error: null
        },
        {
          id: 'clarification-one',
          type: 'clarification',
          question: 'Which path should be used?',
          choices: ['Fast', 'Safe'],
          status: 'pending',
          error: null
        }
      ]
    }
    installApi(running, { respondToApproval, respondToClarification })
    render(<TaskDetailPlaceholder task={task} />)

    const approval = await screen.findByRole('group', { name: 'Approval request' })
    expect(within(approval).getByText('Allow this protected action?')).toBeInTheDocument()
    expect(within(approval).getByLabelText('Protected action preview')).toHaveTextContent(
      'sudo safe-command'
    )
    fireEvent.click(within(approval).getByRole('button', { name: 'Deny' }))
    expect(respondToApproval).toHaveBeenCalledWith(task.id, 'approval-one', false)

    const clarification = screen.getByRole('group', { name: 'Clarification request' })
    fireEvent.change(within(clarification).getByLabelText('Clarification answer'), {
      target: { value: 'Safe' }
    })
    fireEvent.click(within(clarification).getByRole('button', { name: 'Submit' }))
    expect(respondToClarification).toHaveBeenCalledWith(task.id, 'clarification-one', 'Safe')
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeInTheDocument()
  })

  it('renders role-specific rows and repairs only the actively streaming Markdown row', async () => {
    const snapshot: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 3,
      sessionId: task.id,
      status: 'running',
      messages: [
        { id: 'user-one', role: 'user', text: 'Please inspect this.' },
        {
          id: 'tool-one',
          role: 'tool',
          name: 'read_file',
          target: 'notes.txt',
          detail: 'notes.txt',
          failed: true
        },
        {
          id: 'assistant-one',
          role: 'assistant',
          text: 'A **finished** answer.',
          status: 'complete'
        },
        {
          id: 'assistant-two',
          role: 'assistant',
          text: 'A **partial',
          status: 'streaming'
        }
      ]
    }
    installApi(snapshot)
    render(<TaskDetailPlaceholder task={task} />)

    const transcript = await screen.findByRole('log', { name: 'Task transcript' })
    expect(within(transcript).getByText('Please inspect this.').closest('li')).toHaveAttribute(
      'data-message-role',
      'user'
    )
    const tool = within(transcript).getByText('Explored').closest('li')
    expect(tool).toHaveAttribute('data-message-role', 'tool')
    expect(tool).not.toHaveTextContent('notes.txt')
    fireEvent.click(within(tool!).getByRole('button', { name: /Show details/ }))
    expect(tool).toHaveTextContent('notes.txt')
    expect(tool).toHaveTextContent('Failed')
    expect(within(transcript).getByText('finished')).toBeInTheDocument()
    expect(within(transcript).getByText('partial')).toBeInTheDocument()
    expect(within(transcript).queryByText(/\*\*partial/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeInTheDocument()
  })

  it('never shows the previous task transcript while a new task is loading', async () => {
    const snapshot: TranscriptSnapshot = {
      ...emptyTranscriptSnapshot(),
      revision: 1,
      sessionId: task.id,
      status: 'ready',
      messages: [{ id: 'user-one', role: 'user', text: 'Old transcript' }]
    }
    installApi(snapshot)
    const view = render(<TaskDetailPlaceholder task={task} />)
    expect(await screen.findByText('Old transcript')).toBeInTheDocument()

    view.rerender(
      <TaskDetailPlaceholder task={{ ...task, id: 'session-two', title: 'Second task' }} />
    )
    await waitFor(() => expect(screen.queryByText('Old transcript')).not.toBeInTheDocument())
    expect(screen.getByRole('status', { name: 'Transcript is loading' })).toBeInTheDocument()
  })
})
