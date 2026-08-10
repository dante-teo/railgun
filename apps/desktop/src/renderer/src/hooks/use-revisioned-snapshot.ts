import { useEffect, useState } from 'react'

interface RevisionedSnapshot {
  readonly revision: number
}

interface RevisionedUpdate<Snapshot extends RevisionedSnapshot> {
  readonly revision: number
  readonly snapshot: Snapshot
}

interface RevisionedSnapshotSource<Snapshot extends RevisionedSnapshot> {
  readonly getSnapshot: () => Promise<Snapshot>
  readonly subscribe: (listener: (update: RevisionedUpdate<Snapshot>) => void) => () => void
}

function isConsistentUpdate<Snapshot extends RevisionedSnapshot>(
  update: RevisionedUpdate<Snapshot>
): boolean {
  return (
    Number.isSafeInteger(update.revision) &&
    update.revision >= 0 &&
    update.snapshot.revision === update.revision
  )
}

export function newerRevisionedSnapshot<Snapshot extends RevisionedSnapshot>(
  current: Snapshot,
  candidate: Snapshot
): Snapshot {
  return candidate.revision > current.revision ? candidate : current
}

export function useRevisionedSnapshot<Snapshot extends RevisionedSnapshot>(
  initialSnapshot: () => Snapshot,
  source: RevisionedSnapshotSource<Snapshot>
): Snapshot {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const { getSnapshot, subscribe } = source

  useEffect(() => {
    let active = true
    const applySnapshot = (candidate: Snapshot): void => {
      if (active) {
        setSnapshot((current) => newerRevisionedSnapshot(current, candidate))
      }
    }
    const unsubscribe = subscribe((update) => {
      if (isConsistentUpdate(update)) {
        applySnapshot(update.snapshot)
      }
    })
    void getSnapshot().then(applySnapshot, () => undefined)

    return () => {
      active = false
      unsubscribe()
    }
  }, [getSnapshot, subscribe])

  return snapshot
}
