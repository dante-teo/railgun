import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode
} from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const hoverCloseDelayMilliseconds = 80

interface PopoverInteraction {
  active: boolean
  open: boolean
  pinned: boolean
}

interface PersonalAgentActivityPopoverProps {
  active?: boolean
  children: ReactNode
  content: ReactNode
  label: string
  triggerLabel?: string
}

export function PersonalAgentActivityPopover({
  active = true,
  children,
  content,
  label,
  triggerLabel
}: PersonalAgentActivityPopoverProps): React.JSX.Element {
  const [interaction, setInteraction] = useState<PopoverInteraction>({
    active,
    open: false,
    pinned: false
  })
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const contentRef = useRef<HTMLDivElement>(null)

  if (interaction.active !== active) {
    setInteraction({ active, open: false, pinned: false })
  }

  const visibleOpen = active && interaction.open

  const cancelClose = useCallback((): void => {
    if (closeTimer.current !== undefined) {
      clearTimeout(closeTimer.current)
      closeTimer.current = undefined
    }
  }, [])

  const requestClose = useCallback((): void => {
    cancelClose()
    if (interaction.pinned) {
      return
    }
    closeTimer.current = setTimeout(() => {
      setInteraction((current) => ({ ...current, open: false }))
      closeTimer.current = undefined
    }, hoverCloseDelayMilliseconds)
  }, [cancelClose, interaction.pinned])

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      cancelClose()
      if (nextOpen && !active) {
        return
      }
      setInteraction((current) => ({
        ...current,
        open: nextOpen,
        pinned: nextOpen ? current.pinned : false
      }))
    },
    [active, cancelClose]
  )

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLButtonElement>): void => {
      const nextTarget = event.relatedTarget
      if (!(nextTarget instanceof Node) || !contentRef.current?.contains(nextTarget)) {
        requestClose()
      }
    },
    [requestClose]
  )

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.preventDefault()
      if (!active) {
        return
      }
      cancelClose()
      setInteraction((current) => {
        const pinned = !current.pinned
        return { ...current, open: pinned, pinned }
      })
    },
    [active, cancelClose]
  )

  const handleFocus = useCallback((): void => {
    if (!active) {
      return
    }
    cancelClose()
    setInteraction((current) => ({ ...current, open: true }))
  }, [active, cancelClose])

  const handlePointerEnter = useCallback(
    (event: PointerEvent<HTMLButtonElement>): void => {
      if (active && event.pointerType !== 'touch') {
        cancelClose()
        setInteraction((current) => ({ ...current, open: true }))
      }
    },
    [active, cancelClose]
  )

  const handleEscape = useCallback((): void => {
    cancelClose()
    setInteraction((current) => ({ ...current, open: false, pinned: false }))
  }, [cancelClose])

  useEffect(() => () => cancelClose(), [cancelClose])

  return (
    <Popover onOpenChange={handleOpenChange} open={visibleOpen}>
      <PopoverTrigger asChild>
        <button
          aria-expanded={visibleOpen}
          aria-haspopup="dialog"
          aria-label={triggerLabel}
          className="flex min-h-9 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-[background-color,color,transform] duration-(--duration-feedback) ease-(--ease-out) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 pointer-fine:active:scale-[0.97]"
          onBlur={handleBlur}
          onClick={handleClick}
          onFocus={handleFocus}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={requestClose}
          tabIndex={active ? undefined : -1}
          type="button"
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={`${label} preview`}
        collisionPadding={12}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={handleEscape}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={cancelClose}
        onPointerLeave={requestClose}
        ref={contentRef}
        side="right"
        sideOffset={12}
        sticky="always"
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}
