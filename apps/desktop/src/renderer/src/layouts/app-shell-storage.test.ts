import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SHELL_LAYOUT,
  readShellLayout,
  SHELL_LAYOUT_STORAGE_KEY,
  type ShellLayoutRecord,
  writeShellLayout
} from '@/layouts/app-shell-storage'

const validLayout: ShellLayoutRecord = {
  version: 1,
  sidebarWidth: 312,
  contentWidth: 408,
  inspectorWidth: 384,
  sidebarVisible: false,
  inspectorVisible: true
}

function createMemoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()

  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }
}

describe('shell layout storage', () => {
  it('round-trips a valid versioned layout', () => {
    const storage = createMemoryStorage()

    writeShellLayout(storage, validLayout)

    expect(storage.getItem(SHELL_LAYOUT_STORAGE_KEY)).toBe(JSON.stringify(validLayout))
    expect(readShellLayout(storage)).toEqual(validLayout)
  })

  it.each([
    ['malformed JSON', '{'],
    ['obsolete version', JSON.stringify({ ...validLayout, version: 0 })],
    ['out-of-range width', JSON.stringify({ ...validLayout, sidebarWidth: 239 })],
    ['invalid visibility', JSON.stringify({ ...validLayout, sidebarVisible: 'false' })]
  ])('falls back to defaults for %s', (_scenario, storedValue) => {
    const storage = createMemoryStorage()
    storage.setItem(SHELL_LAYOUT_STORAGE_KEY, storedValue)

    expect(readShellLayout(storage)).toEqual(DEFAULT_SHELL_LAYOUT)
  })
})
