import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemeMode = 'auto' | 'light' | 'dark'
type ResolvedTheme = Exclude<ThemeMode, 'auto'>

const themeStorageKey = 'railgun.theme.v1'
const themeModes = new Set<ThemeMode>(['auto', 'light', 'dark'])

interface ThemeContextValue {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

function mediaMatches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false
}

// Theme helpers intentionally share this module with the provider so startup and runtime use one implementation.
// eslint-disable-next-line react-refresh/only-export-components
export function readThemeMode(storage?: Storage): ThemeMode {
  const value = storage?.getItem(themeStorageKey)
  return themeModes.has(value as ThemeMode) ? (value as ThemeMode) : 'auto'
}

// eslint-disable-next-line react-refresh/only-export-components
export function resolveTheme(
  mode: ThemeMode,
  systemDark = mediaMatches('(prefers-color-scheme: dark)')
): ResolvedTheme {
  return mode === 'auto' ? (systemDark ? 'dark' : 'light') : mode
}

// eslint-disable-next-line react-refresh/only-export-components
export function applyTheme(mode: ThemeMode, animate = false): ResolvedTheme {
  const resolved = resolveTheme(mode)
  if (typeof document === 'undefined') {
    return resolved
  }
  const root = document.documentElement
  const changed = root.classList.contains('dark') !== (resolved === 'dark')
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved

  if (
    animate &&
    changed &&
    !mediaMatches('(prefers-reduced-motion: reduce)') &&
    typeof document.getElementById('root')?.animate === 'function'
  ) {
    document.getElementById('root')?.animate([{ opacity: 0.82 }, { opacity: 1 }], {
      duration: 120,
      easing: 'cubic-bezier(0.23, 1, 0.32, 1)'
    })
  }
  return resolved
}

// eslint-disable-next-line react-refresh/only-export-components
export function initializeTheme(): ThemeMode {
  const mode = readThemeMode(typeof window === 'undefined' ? undefined : window.localStorage)
  applyTheme(mode)
  return mode
}

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(() => initializeTheme())
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(mode))

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return
    }
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => {
      if (mode === 'auto') {
        setResolved(applyTheme('auto', true))
      }
    }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [mode])

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolved,
      setMode: (nextMode) => {
        window.localStorage.setItem(themeStorageKey, nextMode)
        setModeState(nextMode)
        setResolved(applyTheme(nextMode, true))
      }
    }),
    [mode, resolved]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return value
}
