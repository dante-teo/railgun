import { Cron } from 'croner'

const maximumScheduleLength = 512
const fieldBounds = [
  { maximum: 59, minimum: 0 },
  { maximum: 23, minimum: 0 },
  { maximum: 31, minimum: 1 },
  { maximum: 12, minimum: 1 },
  { maximum: 7, minimum: 0 }
] as const

export const schedulePresets = {
  hourly: '0 * * * *',
  daily: '0 9 * * *',
  weekdays: '0 9 * * 1-5'
} as const

export type SchedulePreset = keyof typeof schedulePresets | 'custom'

function integer(value: string, minimum: number, maximum: number): number {
  if (!/^\d+$/u.test(value)) throw new Error('Invalid schedule')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Invalid schedule')
  }
  return parsed
}

function validateAtom(atom: string, minimum: number, maximum: number): void {
  const stepParts = atom.split('/')
  if (stepParts.length > 2) throw new Error('Invalid schedule')
  const [base, step] = stepParts
  if (step !== undefined) integer(step, 1, maximum - minimum + 1)
  if (base === '*') return

  const range = base.split('-')
  if (range.length === 1) {
    integer(base, minimum, maximum)
    return
  }
  if (range.length !== 2) throw new Error('Invalid schedule')
  const start = integer(range[0], minimum, maximum)
  const end = integer(range[1], minimum, maximum)
  if (start > end) throw new Error('Invalid schedule')
}

function validateField(field: string, minimum: number, maximum: number): void {
  const atoms = field.split(',')
  if (atoms.some((atom) => !atom)) throw new Error('Invalid schedule')
  atoms.forEach((atom) => validateAtom(atom, minimum, maximum))
}

function cronScheduleForLocalCalculation(schedule: string): string {
  return schedule
    .split(' ')
    .map((field, index) =>
      field
        .split(',')
        .map((atom) => {
          const numericStep = /^(\d+)\/(\d+)$/u.exec(atom)
          return numericStep
            ? `${numericStep[1]}-${fieldBounds[index].maximum}/${numericStep[2]}`
            : atom
        })
        .join(',')
    )
    .join(' ')
}

export function normalizeStoredCronSchedule(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid schedule')
  }
  const normalized = value.trim().split(/\s+/u).join(' ')
  if (
    !normalized ||
    normalized.length > maximumScheduleLength ||
    normalized.split(' ').length !== 5
  ) {
    throw new Error('Invalid schedule: enter a five-field cron expression')
  }
  return normalized
}

export function normalizeCronSchedule(value: unknown): string {
  const normalized = normalizeStoredCronSchedule(value)
  const fields = normalized.split(' ')
  try {
    fields.forEach((field, index) => {
      const bounds = fieldBounds[index]
      validateField(field, bounds.minimum, bounds.maximum)
    })
    if (fields[2] !== '*' && fields[4] !== '*') {
      throw new Error('Invalid schedule')
    }
    new Cron(cronScheduleForLocalCalculation(normalized), { mode: '5-part', paused: true })
  } catch {
    throw new Error('Invalid schedule: enter a valid five-field cron expression')
  }
  return normalized
}

export function detectSchedulePreset(value: unknown): SchedulePreset {
  const schedule = normalizeStoredCronSchedule(value)
  return (Object.entries(schedulePresets).find(([, expression]) => expression === schedule)?.[0] ??
    'custom') as SchedulePreset
}

export function nextScheduleRun(value: unknown, from = new Date()): Date | null {
  const schedule = normalizeStoredCronSchedule(value)
  try {
    return new Cron(cronScheduleForLocalCalculation(schedule), {
      mode: '5-part',
      paused: true
    }).nextRun(from)
  } catch {
    return null
  }
}
