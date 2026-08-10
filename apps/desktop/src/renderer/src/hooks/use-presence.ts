import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type TransitionEvent
} from 'react'

import { transitionEndFallbackMilliseconds } from '@/lib/motion'

export function usePresence(
  present: boolean,
  onExited?: () => void
): {
  mounted: boolean
  handleTransitionEnd: (event: TransitionEvent<HTMLElement>) => void
} {
  const [presence, setPresence] = useState({ mounted: present, source: present })
  const exitCompleted = useRef(false)
  const onExitedRef = useRef(onExited)

  if (presence.source !== present) {
    setPresence({ mounted: present || presence.mounted, source: present })
  }

  useLayoutEffect(() => {
    onExitedRef.current = onExited
    if (present) {
      exitCompleted.current = false
    }
  }, [onExited, present])

  const finishExit = useCallback((): void => {
    if (present || exitCompleted.current) {
      return
    }
    exitCompleted.current = true
    setPresence((current) => ({ ...current, mounted: false }))
    onExitedRef.current?.()
  }, [present])

  useEffect(() => {
    if (!presence.mounted || present) {
      return
    }
    const fallback = setTimeout(finishExit, transitionEndFallbackMilliseconds)
    return () => clearTimeout(fallback)
  }, [finishExit, presence.mounted, present])

  const handleTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLElement>): void => {
      if (event.target === event.currentTarget && event.propertyName === 'opacity') {
        finishExit()
      }
    },
    [finishExit]
  )

  return { mounted: presence.mounted, handleTransitionEnd }
}
