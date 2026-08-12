import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { transitionEndFallbackMilliseconds } from '@/lib/motion'
import { cn } from '@/lib/utils'

interface CrossfadeLayer {
  readonly content: ReactNode
  readonly key: string
  readonly revision: number
}

interface CrossfadeState {
  readonly activeKey: string
  readonly activeRevision: number
  readonly outgoing?: CrossfadeLayer
}

const crossfadeLayerClassName =
  'col-start-1 row-start-1 min-w-0 opacity-100 transition-opacity duration-(--duration-feedback) ease-(--ease-out) starting:data-[motion=entering]:opacity-0 motion-reduce:duration-(--duration-feedback)! motion-reduce:starting:data-[motion=entering]:opacity-[0.92]'

export function Crossfade({
  children,
  layout = 'stack',
  stateKey
}: {
  children: ReactNode
  layout?: 'inline' | 'stack'
  stateKey: string
}): React.JSX.Element {
  const latestContent = useRef(children)
  const [transition, setTransition] = useState<CrossfadeState>({
    activeKey: stateKey,
    activeRevision: 0
  })

  useLayoutEffect(() => {
    if (transition.activeKey !== stateKey) {
      setTransition({
        activeKey: stateKey,
        activeRevision: transition.activeRevision + 1,
        outgoing: {
          content: latestContent.current,
          key: transition.activeKey,
          revision: transition.activeRevision
        }
      })
    }
    latestContent.current = children
  }, [children, stateKey, transition.activeKey, transition.activeRevision])

  const finishOutgoing = useCallback((revision: number): void => {
    setTransition((current) =>
      current.outgoing?.revision === revision ? { ...current, outgoing: undefined } : current
    )
  }, [])

  useEffect(() => {
    const outgoing = transition.outgoing
    if (!outgoing) return
    const fallback = window.setTimeout(
      () => finishOutgoing(outgoing.revision),
      transitionEndFallbackMilliseconds
    )
    return () => window.clearTimeout(fallback)
  }, [finishOutgoing, transition.outgoing])

  const outgoing = transition.outgoing

  return (
    <div
      className={cn(
        layout === 'inline'
          ? 'inline-grid min-w-0 justify-items-end'
          : 'grid w-full min-w-0 items-start'
      )}
      data-layout={layout}
      data-slot="crossfade"
    >
      {outgoing ? (
        <div
          aria-hidden="true"
          className={cn(
            crossfadeLayerClassName,
            'pointer-events-none opacity-0 motion-reduce:opacity-[0.92]'
          )}
          data-motion="exiting"
          data-slot="crossfade-layer"
          inert
          key={`${outgoing.key}-${outgoing.revision}`}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === 'opacity') {
              finishOutgoing(outgoing.revision)
            }
          }}
        >
          {outgoing.content}
        </div>
      ) : null}
      <div
        className={crossfadeLayerClassName}
        data-motion={outgoing ? 'entering' : 'stable'}
        data-slot="crossfade-layer"
        key={`${transition.activeKey}-${transition.activeRevision}`}
      >
        {children}
      </div>
    </div>
  )
}
