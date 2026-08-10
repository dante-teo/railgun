import { emptyTranscriptSnapshot, type TranscriptSnapshot } from '@/lib/transcript-api'

import { newerRevisionedSnapshot, useRevisionedSnapshot } from './use-revisioned-snapshot'

export function newerTranscriptSnapshot(
  current: TranscriptSnapshot,
  candidate: TranscriptSnapshot
): TranscriptSnapshot {
  return newerRevisionedSnapshot(current, candidate)
}

export function useTranscript(): TranscriptSnapshot {
  return useRevisionedSnapshot(emptyTranscriptSnapshot, window.railgun.transcript)
}
