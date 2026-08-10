import { ArrowUpIcon, ChevronDownIcon, PlusIcon, SquareIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import styles from './TaskComposer.module.css'

interface TaskComposerProps {
  approvalExpanded?: boolean
  modelExpanded?: boolean
  sending?: boolean
}

interface ComposerSelectorProps {
  expanded?: boolean
  label: string
  value: string
}

type SendState = 'idle' | 'sending'

interface SendGlyphProps {
  children: React.ReactNode
  state: SendState
}

function ContextRing(): React.JSX.Element {
  return (
    <svg
      aria-label="Context usage"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={0}
      aria-valuetext="No context used"
      className="size-5 shrink-0 text-muted-foreground"
      data-slot="task-composer-context"
      role="progressbar"
      viewBox="0 0 20 20"
    >
      <circle
        className="fill-none stroke-current opacity-30"
        cx="10"
        cy="10"
        r="8"
        strokeWidth="2"
      />
    </svg>
  )
}

function ComposerSelector({ expanded, label, value }: ComposerSelectorProps): React.JSX.Element {
  return (
    <Button
      aria-label={`${label}: ${value}`}
      aria-expanded={expanded}
      data-composer-selector=""
      size="sm"
      type="button"
      variant="ghost"
    >
      {value}
      <span aria-hidden="true" data-slot="task-composer-selector-indicator">
        <ChevronDownIcon data-icon="inline-end" />
      </span>
    </Button>
  )
}

function SendGlyph({ children, state }: SendGlyphProps): React.JSX.Element {
  return (
    <span
      className="absolute inset-0 flex items-center justify-center"
      data-glyph={state}
      data-slot="task-composer-send-glyph"
    >
      {children}
    </span>
  )
}

export function TaskComposer({
  approvalExpanded,
  modelExpanded,
  sending = false
}: TaskComposerProps = {}): React.JSX.Element {
  const sendState: SendState = sending ? 'sending' : 'idle'

  return (
    <div
      aria-label="Message composer"
      className={cn('relative isolate w-full rounded-3xl', styles.composer)}
      data-slot="task-composer"
      role="group"
    >
      <div
        aria-hidden="true"
        className="absolute inset-1 z-0 overflow-hidden rounded-[inherit] blur-md"
        data-slot="task-composer-glow"
      >
        <div data-slot="task-composer-spectrum" />
      </div>
      <div
        className="relative z-10 flex w-full flex-col gap-1 rounded-[inherit] bg-card p-2 ring-1 ring-foreground/10"
        data-slot="task-composer-surface"
      >
        <textarea
          aria-label="Message"
          className="min-h-10 max-h-64 w-full resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm leading-6 text-foreground outline-none field-sizing-content placeholder:text-muted-foreground"
          placeholder="Message"
          rows={1}
        />
        <div
          aria-label="Composer controls"
          className="flex items-center gap-1"
          data-slot="task-composer-toolbar"
          role="group"
        >
          <Button aria-label="Add attachment" size="icon-sm" type="button" variant="ghost">
            <PlusIcon data-icon="inline-start" />
          </Button>
          <ComposerSelector
            expanded={approvalExpanded}
            label="Approval mode"
            value="Ask for approval"
          />
          <span aria-hidden="true" className="flex-1" data-slot="task-composer-spacer" />
          <ContextRing />
          <ComposerSelector expanded={modelExpanded} label="Select model" value="GPT-5" />
          <Button
            aria-label={sendState === 'sending' ? 'Stop generation' : 'Send message'}
            className="rounded-full"
            data-composer-send=""
            data-state={sendState}
            size="icon-sm"
            type="button"
          >
            <span aria-hidden="true" className="relative size-4">
              <SendGlyph state="idle">
                <ArrowUpIcon data-icon="inline-start" />
              </SendGlyph>
              <SendGlyph state="sending">
                <SquareIcon className="fill-current" data-icon="inline-start" />
              </SendGlyph>
            </span>
          </Button>
        </div>
      </div>
    </div>
  )
}
