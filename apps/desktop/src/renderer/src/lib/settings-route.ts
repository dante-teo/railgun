export const settingsCategories = [
  { id: 'general', label: 'General', path: '/settings/general' },
  { id: 'appearance', label: 'Appearance', path: '/settings/appearance' },
  { id: 'personalization', label: 'Personalization', path: '/settings/personalization' },
  { id: 'skills', label: 'Skills', path: '/settings/skills' },
  { id: 'archived-tasks', label: 'Archived Tasks', path: '/settings/archived-tasks' }
] as const

export type SettingsCategory = (typeof settingsCategories)[number]['id']

export function isSettingsCategory(value: string | undefined): value is SettingsCategory {
  return settingsCategories.some(({ id }) => id === value)
}
