import { describe, expect, it } from 'vitest'

import { detectSchedulePreset, nextScheduleRun, normalizeCronSchedule } from '@/lib/cron-schedule'

describe('cron schedule helpers', () => {
  it('normalizes five-field expressions and detects exact presets', () => {
    expect(normalizeCronSchedule('  0   9 * * 1-5 ')).toBe('0 9 * * 1-5')
    expect(detectSchedulePreset('0 * * * *')).toBe('hourly')
    expect(detectSchedulePreset('0 9 * * *')).toBe('daily')
    expect(detectSchedulePreset('0 9 * * 1-5')).toBe('weekdays')
    expect(detectSchedulePreset('15 10 * * *')).toBe('custom')
  })

  it('rejects invalid and non-five-field expressions', () => {
    for (const schedule of [
      '',
      '* * * * * *',
      '60 * * * *',
      '0 9 * * nope',
      '? 9 * * *',
      '0 9 * JAN *',
      '0 9 1 * 1'
    ]) {
      expect(() => normalizeCronSchedule(schedule)).toThrow(/schedule/i)
    }
  })

  it('accepts numeric steps supported by the backend and calculates their next run', () => {
    const from = new Date(2026, 0, 1, 10, 0, 0)
    expect(normalizeCronSchedule(' 0 9 1/2 * * ')).toBe('0 9 1/2 * *')
    expect(nextScheduleRun('0 9 1/2 * *', from)).toEqual(new Date(2026, 0, 3, 9, 0, 0))
  })

  it('calculates the next due time in the current local timezone', () => {
    const from = new Date(2026, 7, 12, 8, 30, 0)
    expect(nextScheduleRun('0 9 * * *', from)).toEqual(new Date(2026, 7, 12, 9, 0, 0))
    expect(nextScheduleRun('0 * * * *', from)).toEqual(new Date(2026, 7, 12, 9, 0, 0))
  })
})
