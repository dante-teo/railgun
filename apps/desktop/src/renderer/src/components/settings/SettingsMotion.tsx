import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type TransitionEvent
} from 'react'

import { Crossfade } from '@/components/motion/Crossfade'
import { transitionEndFallbackMilliseconds } from '@/lib/motion'
import { cn } from '@/lib/utils'

const fallbackFeedbackDurationMilliseconds = 120
const fallbackEaseOut = 'cubic-bezier(0.23, 1, 0.32, 1)'

export function SettingsCrossfade({
  children,
  layout = 'stack',
  stateKey
}: {
  children: ReactNode
  layout?: 'inline' | 'stack'
  stateKey: string
}): React.JSX.Element {
  return (
    <Crossfade layout={layout} stateKey={stateKey}>
      {children}
    </Crossfade>
  )
}

function feedbackTiming(element: HTMLElement): { duration: number; easing: string } {
  const styles = window.getComputedStyle(element)
  const duration = Number.parseFloat(styles.getPropertyValue('--duration-feedback'))
  const easing = styles.getPropertyValue('--ease-out').trim()
  return {
    duration: Number.isFinite(duration) ? duration : fallbackFeedbackDurationMilliseconds,
    easing: easing || fallbackEaseOut
  }
}

export function SettingsAnimatedList({
  ariaLabel,
  children,
  motionRevision
}: {
  ariaLabel: string
  children: ReactNode
  motionRevision: number
}): React.JSX.Element {
  const list = useRef<HTMLUListElement>(null)
  const previousPositions = useRef<ReadonlyMap<string, number>>(new Map())
  const previousMotionRevision = useRef(motionRevision)

  useLayoutEffect(() => {
    const listElement = list.current
    if (!listElement) return
    const elements = Array.from(
      listElement.querySelectorAll<HTMLElement>('[data-settings-list-key]')
    )
    const nextPositions = new Map(
      elements.map((element) => [
        element.dataset.settingsListKey!,
        element.getBoundingClientRect().top
      ])
    )
    const movements = elements.flatMap((element) => {
      const key = element.dataset.settingsListKey!
      const previousTop = previousPositions.current.get(key)
      const nextTop = nextPositions.get(key)!
      const delta = previousTop === undefined ? 0 : previousTop - nextTop
      return delta === 0 ? [] : [{ delta, element }]
    })
    const shouldAnimate = previousMotionRevision.current !== motionRevision
    previousPositions.current = nextPositions
    previousMotionRevision.current = motionRevision

    if (!shouldAnimate || movements.length === 0) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) return
    const timing = feedbackTiming(listElement)
    movements.forEach(({ delta, element }) => {
      if (typeof element.animate === 'function') {
        element.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
          timing
        )
      }
    })
  })

  return (
    <ul aria-label={ariaLabel} className="flex flex-col gap-2" ref={list}>
      {children}
    </ul>
  )
}

export function SettingsListItem({
  align = 'start',
  children,
  entering = false,
  exiting = false,
  itemKey,
  onExitComplete
}: {
  align?: 'center' | 'start'
  children: ReactNode
  entering?: boolean
  exiting?: boolean
  itemKey: string
  onExitComplete?: () => void
}): React.JSX.Element {
  const exitCompleted = useRef(false)
  const onExitCompleteRef = useRef(onExitComplete)

  useLayoutEffect(() => {
    onExitCompleteRef.current = onExitComplete
  }, [onExitComplete])

  const finishExit = useCallback((): void => {
    if (exitCompleted.current) return
    exitCompleted.current = true
    onExitCompleteRef.current?.()
  }, [])

  useEffect(() => {
    if (!exiting) {
      exitCompleted.current = false
      return
    }
    const fallback = window.setTimeout(finishExit, transitionEndFallbackMilliseconds)
    return () => window.clearTimeout(fallback)
  }, [exiting, finishExit])

  return (
    <li
      aria-hidden={exiting ? 'true' : undefined}
      className={cn(
        'flex gap-3 rounded-lg bg-muted/50 p-3',
        align === 'center' ? 'items-center' : 'items-start'
      )}
      data-motion={exiting ? 'exiting' : entering ? 'entering' : 'stable'}
      data-settings-list-key={itemKey}
      data-slot="settings-list-item"
      inert={exiting || undefined}
      onTransitionEnd={(event: TransitionEvent<HTMLLIElement>) => {
        if (exiting && event.target === event.currentTarget && event.propertyName === 'opacity') {
          finishExit()
        }
      }}
    >
      {children}
    </li>
  )
}
