import { useCallback, useState } from 'react'

import type { SubagentActivity } from '@/lib/activity-api'

interface PresentSubagent {
  present: boolean
  subagent: SubagentActivity
}

function reconcileSubagents(
  current: PresentSubagent[],
  next: readonly SubagentActivity[]
): PresentSubagent[] {
  const nextByIndex = new Map(next.map((subagent) => [subagent.index, subagent]))
  const reconciled = current.map((entry) => {
    const subagent = nextByIndex.get(entry.subagent.index)
    if (!subagent) {
      return entry.present ? { ...entry, present: false } : entry
    }
    nextByIndex.delete(entry.subagent.index)
    return { present: true, subagent }
  })

  for (const subagent of nextByIndex.values()) {
    reconciled.push({ present: true, subagent })
  }
  return reconciled.sort((left, right) => left.subagent.index - right.subagent.index)
}

export function usePresentSubagents(subagents: readonly SubagentActivity[]): {
  presentSubagents: PresentSubagent[]
  removeExitedSubagent: (index: number) => void
} {
  const [state, setState] = useState<{
    items: PresentSubagent[]
    source: readonly SubagentActivity[]
  }>(() => ({
    items: subagents.map((subagent) => ({ present: true, subagent })),
    source: subagents
  }))

  if (state.source !== subagents) {
    setState({ items: reconcileSubagents(state.items, subagents), source: subagents })
  }

  const removeExitedSubagent = useCallback((index: number): void => {
    setState((current) => ({
      ...current,
      items: current.items.filter((entry) => entry.subagent.index !== index || entry.present)
    }))
  }, [])

  return { presentSubagents: state.items, removeExitedSubagent }
}
