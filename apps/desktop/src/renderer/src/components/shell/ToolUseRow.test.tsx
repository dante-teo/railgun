import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import type { TranscriptMessage, TranscriptToolMessage } from '@/lib/transcript-api'

import { toolActionLabel, transcriptDisplayRows } from './tool-activity'
import { ExplorationGroupRow, ToolUseRow } from './ToolUseRow'

afterEach(cleanup)

function tool(name: string, options: Partial<TranscriptToolMessage> = {}): TranscriptToolMessage {
  return {
    id: options.id ?? `tool-${name}`,
    role: 'tool',
    name,
    failed: false,
    ...options
  }
}

describe('grouped tool activity', () => {
  it('derives the planned chronological row sequence without mutating transcript messages', () => {
    const messages = [
      tool('read_file', { id: 'read', target: 'one.txt' }),
      tool('list_directory', { id: 'list', target: 'src' }),
      tool('run_shell_command', { id: 'shell-one' }),
      tool('run_shell_command', { id: 'shell-two' }),
      tool('web_search', { id: 'web' }),
      tool('create_file', { id: 'create', target: 'new.txt' }),
      tool('write_file', { id: 'write-one', target: 'one.txt' }),
      tool('write_file', { id: 'write-two', target: 'two.txt' }),
      tool('delete_file', { id: 'delete', target: 'old.txt' })
    ] as const

    const rows = transcriptDisplayRows(messages)
    const labels = rows.map((row) =>
      row.kind === 'exploration'
        ? 'Explored'
        : toolActionLabel(row.message as TranscriptToolMessage)
    )

    expect(labels).toEqual([
      'Explored',
      'Ran command',
      'Ran command',
      'Explored',
      'Created new.txt',
      'Wrote one.txt',
      'Wrote two.txt',
      'Deleted old.txt'
    ])
    render(
      <ol>
        {rows.map((row) =>
          row.kind === 'exploration' ? (
            <ExplorationGroupRow key={row.id} messages={row.messages} />
          ) : row.message.role === 'tool' ? (
            <ToolUseRow key={row.id} message={row.message} />
          ) : null
        )}
      </ol>
    )
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(labels)
    expect(messages).toHaveLength(9)
    expect(messages[0].id).toBe('read')
  })

  it('ends groups at consequential tools and visible transcript messages', () => {
    const visibleAssistant: TranscriptMessage = {
      id: 'assistant',
      role: 'assistant',
      text: 'Visible progress',
      status: 'complete'
    }
    const rows = transcriptDisplayRows([
      tool('read_file', { id: 'read-one' }),
      tool('run_shell_command', { id: 'shell' }),
      tool('list_directory', { id: 'list-one' }),
      visibleAssistant,
      tool('read_file', { id: 'read-two' })
    ])

    expect(rows.map((row) => row.kind)).toEqual([
      'exploration',
      'message',
      'exploration',
      'message',
      'exploration'
    ])
  })

  it('shows failed children inside a completed exploration group', () => {
    render(
      <ol>
        <ExplorationGroupRow
          messages={[
            tool('read_file', { id: 'read', target: 'notes.txt', failed: true }),
            tool('web_search', { id: 'web' })
          ]}
        />
      </ol>
    )

    const trigger = screen.getByRole('button', { name: 'Explored, failed. Show details' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger.querySelector('[data-failure-indicator="true"]')).toHaveClass('lucide-circle-x')
    expect(screen.queryByText('Read notes.txt')).not.toBeInTheDocument()

    fireEvent.click(trigger)

    expect(trigger).toHaveAccessibleName('Explored, failed. Hide details')
    const details = screen.getByRole('list', { name: 'Exploration details' })
    expect(within(details).getByText('Read notes.txt')).toBeInTheDocument()
    expect(within(details).getByText('Searched the web')).toBeInTheDocument()
    expect(within(details).getByText('Failed')).toBeInTheDocument()
    expect(details).not.toHaveClass('border')
    expect(details).not.toHaveClass('bg-muted/40')
  })

  it('does not let the hidden failure indicator add another label-to-chevron gap', () => {
    render(
      <ol>
        <ExplorationGroupRow messages={[tool('read_file')]} />
      </ol>
    )

    const trigger = screen.getByRole('button', { name: 'Explored. Show details' })
    const endControls = trigger.querySelector('[data-slot="tool-row-end-controls"]')
    expect(endControls).toContainElement(trigger.querySelector('.lucide-chevron-right'))
    expect(endControls).not.toHaveClass('gap-2')
  })

  it('keeps a running group open and locked, then collapses immediately on completion', () => {
    const view = render(
      <ol>
        <ExplorationGroupRow messages={[tool('read_file', { running: true })]} />
      </ol>
    )

    const trigger = screen.getByRole('button', { name: 'Explored, in progress' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('In progress')).toBeInTheDocument()
    expect(screen.getByText('Read file')).toBeInTheDocument()

    view.rerender(
      <ol>
        <ExplorationGroupRow messages={[tool('read_file')]} />
      </ol>
    )

    const completedTrigger = screen.getByRole('button', { name: 'Explored. Show details' })
    expect(completedTrigger).not.toBeDisabled()
    expect(completedTrigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Read file')).not.toBeInTheDocument()
  })

  it('marks only the live exploration child for entrance motion', () => {
    render(
      <ol>
        <ExplorationGroupRow
          messages={[
            tool('read_file', { id: 'read', target: 'notes.txt' }),
            tool('web_search', { id: 'search', running: true })
          ]}
        />
      </ol>
    )

    expect(screen.getByText('Read notes.txt').closest('li')).not.toHaveAttribute('data-live')
    expect(screen.getByText('Searched the web').closest('li')).toHaveAttribute('data-live', 'true')
  })

  it('keeps the exploration failure indicator mounted across a live failure', () => {
    const view = render(
      <ol>
        <ExplorationGroupRow messages={[tool('read_file', { running: true })]} />
      </ol>
    )

    const runningTrigger = screen.getByRole('button', { name: 'Explored, in progress' })
    const failureIndicator = runningTrigger.querySelector('[data-slot="failure-indicator"]')
    expect(failureIndicator).toHaveAttribute('data-visible', 'false')

    view.rerender(
      <ol>
        <ExplorationGroupRow messages={[tool('read_file', { failed: true })]} />
      </ol>
    )

    const completedTrigger = screen.getByRole('button', {
      name: 'Explored, failed. Show details'
    })
    expect(completedTrigger.querySelector('[data-slot="failure-indicator"]')).toBe(failureIndicator)
    expect(failureIndicator).toHaveAttribute('data-visible', 'true')
  })
})

describe('consequential tool rows', () => {
  it('uses the requested action labels and humanizes unknown tools', () => {
    const messages = [
      tool('run_shell_command'),
      tool('create_file', { target: '/private/project/created.txt' }),
      tool('write_file', { target: 'written.txt' }),
      tool('delete_file', { target: 'deleted.txt' }),
      tool('todo', { id: 'todo-review', detail: 'Current task list' }),
      tool('todo', { id: 'todo-update', detail: '2 task items' }),
      tool('clarify'),
      tool('memory_write'),
      tool('memory_consolidate'),
      tool('cron', { id: 'cron-list', detail: 'Scheduled tasks' }),
      tool('cron', { id: 'cron-add', detail: 'Add scheduled task' }),
      tool('cron', { id: 'cron-update', detail: 'Update scheduled task' }),
      tool('cron', { id: 'cron-remove', detail: 'Remove scheduled task' }),
      tool('skill_view'),
      tool('delegate_task'),
      tool('custom-audit_tool')
    ]

    render(
      <ol>
        {messages.map((message) => (
          <ToolUseRow key={message.id} message={message} />
        ))}
      </ol>
    )

    for (const label of [
      'Ran command',
      'Created created.txt',
      'Wrote written.txt',
      'Deleted deleted.txt',
      'Reviewed tasks',
      'Updated tasks',
      'Asked for clarification',
      'Remembered',
      'Organized memories',
      'Checked schedules',
      'Scheduled task',
      'Updated schedule',
      'Removed schedule',
      'Used skill',
      'Delegated tasks',
      'Custom Audit Tool'
    ]) {
      expect(screen.getByRole('button', { name: `${label}. Show details` })).toBeInTheDocument()
    }
    expect(screen.queryByText('/private/project')).not.toBeInTheDocument()
  })

  it('supports disclosure by mouse, Enter, and Space with updated accessible names', async () => {
    const user = userEvent.setup()
    render(
      <ol>
        <ToolUseRow message={tool('memory_write', { detail: 'Preference memory' })} />
      </ol>
    )
    const trigger = screen.getByRole('button', { name: 'Remembered. Show details' })

    await user.click(trigger)
    expect(trigger).toHaveAccessibleName('Remembered. Hide details')
    await user.click(trigger)

    trigger.focus()
    await user.keyboard('{Enter}')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('frames only real file diffs and leaves shell and status details unframed', () => {
    const rows = [
      tool('write_file', {
        id: 'changed',
        target: 'notes.txt',
        fileChange: {
          status: 'changed',
          diff: '--- notes.txt\n+++ notes.txt\n@@ -1 +1 @@\n-old\n+new\n',
          truncated: false
        }
      }),
      tool('write_file', {
        id: 'unchanged',
        target: 'same.txt',
        fileChange: { status: 'unchanged' }
      }),
      tool('create_file', {
        id: 'empty',
        target: 'empty.txt',
        fileChange: { status: 'changed', diff: '', truncated: false }
      }),
      tool('write_file', {
        id: 'unavailable',
        target: 'binary.txt',
        fileChange: { status: 'unavailable' }
      }),
      tool('run_shell_command', {
        id: 'shell',
        command: 'pnpm test',
        output: '21 tests passed'
      }),
      tool('memory_write', { id: 'memory', detail: 'Preference memory' })
    ]
    render(
      <ol>
        {rows.map((message) => (
          <ToolUseRow key={message.id} message={message} />
        ))}
      </ol>
    )

    for (const trigger of screen.getAllByRole('button')) {
      fireEvent.click(trigger)
    }

    const diff = screen.getByLabelText('Diff for notes.txt')
    expect(diff).toHaveClass('border')
    expect(diff).toHaveClass('bg-muted/40')
    expect(diff).toHaveClass('font-mono')
    expect(screen.getByText('No content changes')).not.toHaveClass('border')
    expect(screen.getByText('Created an empty file')).not.toHaveClass('border')
    expect(screen.getByText('Diff unavailable')).not.toHaveClass('border')
    const shell = screen.getByLabelText('Shell command').closest('[data-slot="tool-details"]')
    expect(shell).toHaveClass('font-mono')
    expect(shell).not.toHaveClass('border')
    expect(shell).not.toHaveClass('bg-muted/40')
    expect(screen.getByText('Preference memory')).not.toHaveClass('border')
  })

  it('keeps failed unknown tools understandable', () => {
    render(
      <ol>
        <ToolUseRow message={tool('custom-audit_tool', { failed: true })} />
      </ol>
    )

    const trigger = screen.getByRole('button', {
      name: 'Custom Audit Tool, failed. Show details'
    })
    expect(trigger.querySelector('[data-failure-indicator="true"]')).toHaveClass('lucide-circle-x')
    fireEvent.click(trigger)
    expect(screen.getByText('Tool activity')).toBeInTheDocument()
  })

  it('keeps a consequential tool failure indicator mounted across completion', () => {
    const view = render(
      <ol>
        <ToolUseRow message={tool('run_shell_command', { running: true })} />
      </ol>
    )

    const runningTrigger = screen.getByRole('button', { name: 'Ran command, in progress' })
    const failureIndicator = runningTrigger.querySelector('[data-slot="failure-indicator"]')
    expect(failureIndicator).toHaveAttribute('data-visible', 'false')

    view.rerender(
      <ol>
        <ToolUseRow message={tool('run_shell_command', { failed: true })} />
      </ol>
    )

    const completedTrigger = screen.getByRole('button', {
      name: 'Ran command, failed. Show details'
    })
    expect(completedTrigger.querySelector('[data-slot="failure-indicator"]')).toBe(failureIndicator)
    expect(failureIndicator).toHaveAttribute('data-visible', 'true')
  })
})
