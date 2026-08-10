import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { usePresence } from '@/hooks/use-presence'

export function ActivityRowPresence({
  children,
  kind,
  onExited,
  present
}: {
  children: ReactNode
  kind: 'subagent' | 'tasks'
  onExited?: () => void
  present: boolean
}): React.JSX.Element | null {
  const { mounted, handleTransitionEnd } = usePresence(present, onExited)
  if (!mounted) {
    return null
  }

  return (
    <div
      aria-hidden={present ? undefined : true}
      className="translate-y-0 opacity-100 transition-[opacity,transform] duration-(--duration-feedback) ease-(--ease-out) starting:translate-y-0.5 starting:opacity-0 data-[present=false]:pointer-events-none data-[present=false]:translate-y-0.5 data-[present=false]:opacity-0 data-[present=false]:duration-100 motion-reduce:transform-none! motion-reduce:transition-opacity! motion-reduce:duration-(--duration-feedback)!"
      data-activity-row={kind}
      data-present={present}
      data-slot="activity-row-presence"
      inert={present ? undefined : true}
      onTransitionEnd={handleTransitionEnd}
    >
      {children}
    </div>
  )
}

interface StatusLayer {
  entering: boolean
  id: number
  label: string
  present: boolean
}

function ActivityStatusLayer({
  layer,
  onExited
}: {
  layer: StatusLayer
  onExited: (id: number) => void
}): React.JSX.Element | null {
  const finishExit = useCallback(() => onExited(layer.id), [layer.id, onExited])
  const { mounted, handleTransitionEnd } = usePresence(layer.present, finishExit)
  if (!mounted) {
    return null
  }

  return (
    <span
      aria-hidden="true"
      className="col-start-1 row-start-1 whitespace-nowrap text-right opacity-100 transition-opacity duration-(--duration-feedback) ease-(--ease-out) starting:data-[entering=true]:opacity-0 data-[present=false]:opacity-0 data-[present=false]:duration-100 motion-reduce:transition-opacity! motion-reduce:duration-(--duration-feedback)!"
      data-entering={layer.entering || undefined}
      data-present={layer.present}
      data-slot="activity-status-layer"
      onTransitionEnd={handleTransitionEnd}
    >
      {layer.label}
    </span>
  )
}

export function ActivityStatus({ label }: { label: string }): React.JSX.Element {
  const previousLabel = useRef(label)
  const nextLayerId = useRef(1)
  const [layers, setLayers] = useState<StatusLayer[]>([
    { entering: false, id: 0, label, present: true }
  ])

  useLayoutEffect(() => {
    if (previousLabel.current === label) {
      return
    }
    previousLabel.current = label
    const id = nextLayerId.current++
    setLayers((current) => [
      ...current.map((layer) => ({ ...layer, present: false })),
      { entering: true, id, label, present: true }
    ])
  }, [label])

  const removeExitedLayer = useCallback((id: number): void => {
    setLayers((current) => current.filter((layer) => layer.id !== id))
  }, [])

  return (
    <span
      aria-label={label}
      className="grid shrink-0 text-[11px] text-muted-foreground"
      data-slot="activity-status"
    >
      {layers.map((layer) => (
        <ActivityStatusLayer key={layer.id} layer={layer} onExited={removeExitedLayer} />
      ))}
    </span>
  )
}
