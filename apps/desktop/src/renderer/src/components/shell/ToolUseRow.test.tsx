import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { TranscriptToolMessage } from '@/lib/transcript-api'

import { ToolUseRow } from './ToolUseRow'

afterEach(cleanup)

function tool(name: string, options: Partial<TranscriptToolMessage> = {}): TranscriptToolMessage {
  return {
    id: `tool-${name}`,
    role: 'tool',
    name,
    failed: false,
    ...options
  }
}

describe('tool use row', () => {
  it('uses the icon, human label, chevron disclosure anatomy and reveals simplified details', () => {
    render(
      <ol>
        <ToolUseRow
          message={tool('read_file', {
            detail: 'notes.txt',
            failed: true
          })}
        />
      </ol>
    )

    const trigger = screen.getByRole('button', {
      name: 'Read File, failed. Show details'
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger.children).toHaveLength(3)
    expect(trigger.children[0]?.tagName).toBe('svg')
    expect(trigger.querySelector('[data-failure-indicator="true"]')).toHaveClass('lucide-circle-x')
    expect(trigger.children[1]).toHaveTextContent('Read File')
    expect(trigger.children[2]?.tagName).toBe('svg')
    expect(trigger.children[2]).not.toHaveClass('ml-auto')
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument()

    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAccessibleName('Read File, failed. Hide details')
    const details = screen.getByText('notes.txt').closest('[data-slot="tool-details"]')
    expect(details).not.toBeNull()
    expect(details).not.toHaveClass('border')
    expect(details).not.toHaveClass('bg-muted/40')
    expect(details).toHaveTextContent('notes.txt')
    expect(details).not.toHaveTextContent('Failed')

    fireEvent.click(trigger)
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument()
  })

  it('maps every built-in tool to a readable label', () => {
    const names = [
      ['read_file', 'Read File'],
      ['write_file', 'Write File'],
      ['list_directory', 'List Directory'],
      ['run_shell_command', 'Run Shell Command'],
      ['todo', 'Update Tasks'],
      ['clarify', 'Ask for Clarification'],
      ['memory_write', 'Save Memory'],
      ['memory_search', 'Search Memories'],
      ['memory_consolidate', 'Consolidate Memories'],
      ['cron', 'Manage Schedule'],
      ['railgun_inspect', 'Inspect Railgun'],
      ['skill_view', 'View Skill'],
      ['web_search', 'Search Web'],
      ['web_fetch', 'Fetch Web Page'],
      ['delegate_task', 'Delegate Task']
    ] as const

    render(
      <ol>
        {names.map(([name]) => (
          <ToolUseRow key={name} message={tool(name)} />
        ))}
      </ol>
    )

    for (const [, label] of names) {
      expect(screen.getByRole('button', { name: `${label}. Show details` })).toBeInTheDocument()
    }
  })

  it('keeps a running tool expanded and locked, then automatically collapses on completion', () => {
    const view = render(
      <ol>
        <ToolUseRow message={tool('custom-audit_tool', { running: true })} />
      </ol>
    )

    const trigger = screen.getByRole('button', {
      name: 'Custom Audit Tool, in progress'
    })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('In progress')).toBeInTheDocument()
    expect(screen.getByText('Tool activity')).toBeInTheDocument()

    view.rerender(
      <ol>
        <ToolUseRow message={tool('custom-audit_tool')} />
      </ol>
    )

    expect(trigger).not.toBeDisabled()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAccessibleName('Custom Audit Tool. Show details')
    expect(screen.queryByText('Tool activity')).not.toBeInTheDocument()
  })

  it('frames only shell-command details', () => {
    render(
      <ol>
        <ToolUseRow
          message={tool('run_shell_command', {
            command: 'pnpm test',
            detail: 'Local shell command',
            output: '21 tests passed'
          })}
        />
      </ol>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Run Shell Command. Show details' }))
    const details = screen.getByLabelText('Shell command').closest('[data-slot="tool-details"]')
    expect(details).toHaveClass('border')
    expect(details).toHaveClass('bg-muted/40')
    expect(details).toHaveClass('font-mono')
    expect(screen.getByLabelText('Shell command')).toHaveTextContent('$ pnpm test')
    expect(screen.getByLabelText('Shell output')).toHaveTextContent('21 tests passed')
    expect(details).not.toHaveTextContent('Completed')
  })
})
