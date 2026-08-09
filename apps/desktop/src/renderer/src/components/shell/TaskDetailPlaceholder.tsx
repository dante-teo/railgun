import { AtSign, Circle, Paperclip, Send, Smile } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type PlaceholderWidth = 'short' | 'medium' | 'wide'

interface PlaceholderLineProps {
  width: PlaceholderWidth
}

interface PlaceholderGroup {
  readonly id: string
  readonly offset: 'mt-11' | 'mt-14'
  readonly widths: readonly PlaceholderWidth[]
}

const PLACEHOLDER_GROUPS: readonly PlaceholderGroup[] = [
  { id: 'summary', offset: 'mt-11', widths: ['short', 'medium', 'wide'] },
  { id: 'notes', offset: 'mt-14', widths: ['short', 'wide', 'wide'] },
  { id: 'activity', offset: 'mt-14', widths: ['short', 'wide', 'wide'] }
]

function PlaceholderLine({ width }: PlaceholderLineProps): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn('block h-2.5 rounded-full bg-placeholder', {
        'w-[31%]': width === 'short',
        'w-[48%]': width === 'medium',
        'w-[81%]': width === 'wide'
      })}
    />
  )
}

function ComposerPlaceholder(): React.JSX.Element {
  return (
    <section
      aria-label="Task composer"
      className="flex h-[96px] items-center rounded-lg border bg-card px-4 shadow-minimal"
    >
      <Button aria-label="Attach file" size="icon-sm" type="button" variant="ghost">
        <Paperclip aria-hidden="true" data-icon="inline-start" strokeWidth={1.65} />
      </Button>
      <span className="ml-2 min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
        Add a note or update...
      </span>
      <div className="flex items-center gap-1">
        <Button aria-label="Mention someone" size="icon-sm" type="button" variant="ghost">
          <AtSign aria-hidden="true" data-icon="inline-start" strokeWidth={1.65} />
        </Button>
        <Button aria-label="Add emoji" size="icon-sm" type="button" variant="ghost">
          <Smile aria-hidden="true" data-icon="inline-start" strokeWidth={1.65} />
        </Button>
        <Button aria-label="Send update" size="icon-sm" type="button" variant="ghost">
          <Send
            aria-hidden="true"
            data-icon="inline-start"
            className="text-primary"
            strokeWidth={1.75}
          />
        </Button>
      </div>
    </section>
  )
}

export function TaskDetailPlaceholder(): React.JSX.Element {
  return (
    <section className="flex h-full min-h-0 flex-col px-7 py-10">
      <div className="flex items-center gap-4">
        <Circle
          aria-hidden="true"
          className="size-[18px] shrink-0 text-subtle-foreground"
          strokeWidth={1.45}
        />
        <h2 className="text-[21px] font-semibold leading-none tracking-[-0.015em]">
          Draft project brief
        </h2>
      </div>

      {PLACEHOLDER_GROUPS.map(({ id, offset, widths }) => (
        <div className={cn('flex flex-col gap-5', offset)} key={id}>
          {widths.map((width, index) => (
            <PlaceholderLine key={`${id}-${width}-${index}`} width={width} />
          ))}
        </div>
      ))}

      <div className="mt-auto pt-8">
        <ComposerPlaceholder />
      </div>
    </section>
  )
}
