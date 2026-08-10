import { emptyContextUsageSnapshot, type ContextUsageSnapshot } from '@/lib/context-usage-api'

import { newerRevisionedSnapshot, useRevisionedSnapshot } from './use-revisioned-snapshot'

export function newerContextUsageSnapshot(
  current: ContextUsageSnapshot,
  candidate: ContextUsageSnapshot
): ContextUsageSnapshot {
  return newerRevisionedSnapshot(current, candidate)
}

export function useContextUsage(): ContextUsageSnapshot {
  return useRevisionedSnapshot(emptyContextUsageSnapshot, window.railgun.contextUsage)
}
