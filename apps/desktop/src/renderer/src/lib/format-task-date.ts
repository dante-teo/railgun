const millisecondsPerDay = 86_400_000

function localCalendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
}

export function formatTaskDate(timestamp: string, now: Date = new Date(), locale?: string): string {
  const date = new Date(timestamp)
  const daysAgo = (localCalendarDay(now) - localCalendarDay(date)) / millisecondsPerDay

  if (daysAgo === 0) {
    return 'Today'
  }
  if (daysAgo === 1) {
    return 'Yesterday'
  }

  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  }).format(date)
}

export function formatFullTaskTimestamp(timestamp: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
    timeStyle: 'long'
  }).format(new Date(timestamp))
}
