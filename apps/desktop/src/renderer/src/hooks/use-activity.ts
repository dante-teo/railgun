import { emptyActivitySnapshot, type ActivitySnapshot } from '@/lib/activity-api'

import { newerRevisionedSnapshot, useRevisionedSnapshot } from './use-revisioned-snapshot'

export function newerActivitySnapshot(
  current: ActivitySnapshot,
  candidate: ActivitySnapshot
): ActivitySnapshot {
  return newerRevisionedSnapshot(current, candidate)
}

export function useActivity(): ActivitySnapshot {
  return useRevisionedSnapshot(emptyActivitySnapshot, window.railgun.activity)
}
