import { useEffect, useState } from 'react'

import {
  emptyActivitySnapshot,
  type ActivitySnapshot,
  type ActivityUpdate
} from '@/lib/activity-api'

function isConsistentUpdate(update: ActivityUpdate): boolean {
  return (
    Number.isSafeInteger(update.revision) &&
    update.revision >= 0 &&
    update.snapshot.revision === update.revision
  )
}

export function newerActivitySnapshot(
  current: ActivitySnapshot,
  candidate: ActivitySnapshot
): ActivitySnapshot {
  return candidate.revision > current.revision ? candidate : current
}

export function useActivity(): ActivitySnapshot {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(emptyActivitySnapshot)

  useEffect(() => {
    let active = true
    const applySnapshot = (candidate: ActivitySnapshot): void => {
      if (active) {
        setSnapshot((current) => newerActivitySnapshot(current, candidate))
      }
    }
    const unsubscribe = window.railgun.activity.subscribe((update) => {
      if (isConsistentUpdate(update)) {
        applySnapshot(update.snapshot)
      }
    })
    void window.railgun.activity.getSnapshot().then(applySnapshot, () => undefined)

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return snapshot
}
