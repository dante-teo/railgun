import { useState, type ComponentProps, type ReactNode, type TransitionEvent } from 'react'

import { usePresence } from '@/hooks/use-presence'
import { cn } from '@/lib/utils'

type FeedbackPresenceProps = Omit<ComponentProps<'div'>, 'children'> & {
  children?: ReactNode
  present?: boolean
  stateKey?: string
  variant?: 'inline' | 'notice'
}

function hasFeedbackContent(content: ReactNode): boolean {
  if (Array.isArray(content)) {
    return content.some(hasFeedbackContent)
  }
  return content !== null && content !== undefined && typeof content !== 'boolean' && content !== ''
}

function feedbackStateKey(content: ReactNode): string {
  return typeof content === 'string' || typeof content === 'number' || typeof content === 'bigint'
    ? String(content)
    : hasFeedbackContent(content)
      ? 'custom'
      : 'empty'
}

/**
 * Retains occasional asynchronous feedback while it exits. Keep typing-driven validation
 * immediate, and provide a stateKey when composite children can change while still present.
 */
export function FeedbackPresence({
  'aria-hidden': ariaHidden,
  children,
  className,
  inert,
  onTransitionEnd,
  present,
  role,
  stateKey,
  variant = 'inline',
  ...props
}: FeedbackPresenceProps): React.JSX.Element | null {
  const resolvedPresent = present ?? hasFeedbackContent(children)
  const resolvedStateKey = stateKey ?? feedbackStateKey(children)
  const [retained, setRetained] = useState({ content: children, stateKey: resolvedStateKey })
  const presence = usePresence(resolvedPresent)

  if (resolvedPresent && retained.stateKey !== resolvedStateKey) {
    setRetained({ content: children, stateKey: resolvedStateKey })
  }

  if (!presence.mounted) return null

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>): void => {
    presence.handleTransitionEnd(event)
    onTransitionEnd?.(event)
  }

  return (
    <div
      {...props}
      aria-hidden={resolvedPresent ? ariaHidden : true}
      className={cn(
        'translate-y-0 opacity-100 transition-[opacity,translate] duration-(--duration-feedback) ease-(--ease-out) starting:opacity-0 data-[present=false]:pointer-events-none data-[present=false]:opacity-0 data-[present=false]:duration-100 motion-reduce:translate-none! motion-reduce:transition-opacity! motion-reduce:duration-(--duration-feedback)! motion-reduce:starting:opacity-[0.92] motion-reduce:data-[present=false]:opacity-[0.92]',
        variant === 'notice'
          ? 'starting:-translate-y-1 data-[present=false]:-translate-y-1'
          : 'starting:-translate-y-0.5 data-[present=false]:-translate-y-0.5',
        className
      )}
      data-present={resolvedPresent}
      inert={resolvedPresent ? inert : true}
      onTransitionEnd={handleTransitionEnd}
      role={resolvedPresent ? role : undefined}
    >
      {resolvedPresent ? children : retained.content}
    </div>
  )
}
