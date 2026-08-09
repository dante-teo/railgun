export const SHELL_LAYOUT_STORAGE_KEY = 'railgun.shell.layout.v1'
const SHELL_LAYOUT_VERSION = 1 as const

export const SHELL_LAYOUT_CONSTRAINTS = {
  sidebar: { default: 260, min: 240, max: 360 },
  content: { default: 340, min: 300, max: 520 },
  inspector: { default: 320, min: 280, max: 440 },
  detail: { min: 420 },
  workspace: { minWithDetail: 720 }
} as const

export interface ShellLayoutRecord {
  readonly version: typeof SHELL_LAYOUT_VERSION
  readonly sidebarWidth: number
  readonly contentWidth: number
  readonly inspectorWidth: number
  readonly sidebarVisible: boolean
  readonly inspectorVisible: boolean
}

export const DEFAULT_SHELL_LAYOUT: ShellLayoutRecord = {
  version: SHELL_LAYOUT_VERSION,
  sidebarWidth: SHELL_LAYOUT_CONSTRAINTS.sidebar.default,
  contentWidth: SHELL_LAYOUT_CONSTRAINTS.content.default,
  inspectorWidth: SHELL_LAYOUT_CONSTRAINTS.inspector.default,
  sidebarVisible: true,
  inspectorVisible: true
}

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

function isWidthInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

export function isShellLayoutRecord(value: unknown): value is ShellLayoutRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const record = value as Record<string, unknown>

  return (
    record.version === SHELL_LAYOUT_VERSION &&
    isWidthInRange(
      record.sidebarWidth,
      SHELL_LAYOUT_CONSTRAINTS.sidebar.min,
      SHELL_LAYOUT_CONSTRAINTS.sidebar.max
    ) &&
    isWidthInRange(
      record.contentWidth,
      SHELL_LAYOUT_CONSTRAINTS.content.min,
      SHELL_LAYOUT_CONSTRAINTS.content.max
    ) &&
    isWidthInRange(
      record.inspectorWidth,
      SHELL_LAYOUT_CONSTRAINTS.inspector.min,
      SHELL_LAYOUT_CONSTRAINTS.inspector.max
    ) &&
    typeof record.sidebarVisible === 'boolean' &&
    typeof record.inspectorVisible === 'boolean'
  )
}

export function readShellLayout(storage?: LayoutStorage): ShellLayoutRecord {
  if (!storage) {
    return DEFAULT_SHELL_LAYOUT
  }

  try {
    const rawLayout = storage.getItem(SHELL_LAYOUT_STORAGE_KEY)
    if (!rawLayout) {
      return DEFAULT_SHELL_LAYOUT
    }

    const parsedLayout: unknown = JSON.parse(rawLayout)
    return isShellLayoutRecord(parsedLayout) ? parsedLayout : DEFAULT_SHELL_LAYOUT
  } catch {
    return DEFAULT_SHELL_LAYOUT
  }
}

export function writeShellLayout(
  storage: LayoutStorage | undefined,
  layout: ShellLayoutRecord
): void {
  if (!storage || !isShellLayoutRecord(layout)) {
    return
  }

  try {
    storage.setItem(SHELL_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // Layout persistence is a progressive enhancement; the shell remains usable without it.
  }
}
