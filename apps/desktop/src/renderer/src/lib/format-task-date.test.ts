import { describe, expect, it } from 'vitest'

import { formatTaskDate } from '@/lib/format-task-date'

function localTimestamp(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12).toISOString()
}

describe('formatTaskDate', () => {
  const now = new Date(2026, 7, 9, 12)

  it('formats today and yesterday relative to the local calendar', () => {
    expect(formatTaskDate(localTimestamp(2026, 8, 9), now, 'en-US')).toBe('Today')
    expect(formatTaskDate(localTimestamp(2026, 8, 8), now, 'en-US')).toBe('Yesterday')
  })

  it('uses localized short dates with a year only when needed', () => {
    expect(formatTaskDate(localTimestamp(2026, 8, 7), now, 'en-US')).toBe('Aug 7')
    expect(formatTaskDate(localTimestamp(2025, 8, 8), now, 'en-US')).toBe('Aug 8, 2025')
  })
})
