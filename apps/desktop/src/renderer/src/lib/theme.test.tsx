import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { ThemeProvider, applyTheme, readThemeMode, useTheme } from '@/lib/theme'

const themeStyles = readFileSync(resolve(process.cwd(), 'src/renderer/src/assets/main.css'), 'utf8')
const customSemanticTokens = [
  '--primary-hover',
  '--canvas',
  '--surface-active',
  '--subtle-foreground',
  '--placeholder'
]
const sidebarThemeTokens = [
  '--sidebar',
  '--sidebar-opaque',
  '--sidebar-foreground',
  '--sidebar-card',
  '--sidebar-card-foreground',
  '--sidebar-muted',
  '--sidebar-muted-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-border',
  '--sidebar-border-strong',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-ring',
  '--sidebar-sheen-violet',
  '--sidebar-sheen-cyan',
  '--sidebar-highlight'
]

function ThemeProbe(): React.JSX.Element {
  const { mode, resolved, setMode } = useTheme()
  return (
    <div>
      <span>
        {mode}:{resolved}
      </span>
      <button onClick={() => setMode('dark')} type="button">
        Dark
      </button>
    </div>
  )
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  document.documentElement.classList.remove('dark')
})

it('persists and applies theme choices immediately', () => {
  render(
    <ThemeProvider>
      <ThemeProbe />
    </ThemeProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Dark' }))
  expect(document.documentElement).toHaveClass('dark')
  expect(readThemeMode(window.localStorage)).toBe('dark')
  expect(screen.getByText('dark:dark')).toBeInTheDocument()
})

it('tracks live system changes in Auto mode', async () => {
  let dark = false
  let listener: (() => void) | undefined
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      get matches() {
        return dark
      },
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: (_event: string, next: () => void) => {
        listener = next
      },
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    })
  })
  render(
    <ThemeProvider>
      <ThemeProbe />
    </ThemeProvider>
  )
  expect(screen.getByText('auto:light')).toBeInTheDocument()
  dark = true
  await act(async () => listener?.())
  expect(screen.getByText('auto:dark')).toBeInTheDocument()
  expect(document.documentElement).toHaveClass('dark')
  applyTheme('light')
})

it('defines every custom semantic token in both theme palettes', () => {
  const lightDeclarations = themeStyles.match(/:root\s*\{([\s\S]*?)\}/u)?.[1]
  const darkDeclarations = themeStyles.match(/\.dark\s*\{([\s\S]*?)\}/u)?.[1]

  expect(lightDeclarations).toBeDefined()
  expect(darkDeclarations).toBeDefined()
  for (const declarations of [lightDeclarations, darkDeclarations]) {
    for (const token of [...customSemanticTokens, ...sidebarThemeTokens]) {
      expect(declarations).toMatch(new RegExp(`${token}:\\s*[^;]+;`, 'u'))
    }
  }
})

it('scopes semantic component colors to the sidebar material', () => {
  const materialDeclarations = themeStyles.match(/\.sidebar-material\s*\{([\s\S]*?)\}/u)?.[1]
  const semanticMappings = [
    ['--foreground', '--sidebar-foreground'],
    ['--card', '--sidebar-card'],
    ['--card-foreground', '--sidebar-card-foreground'],
    ['--muted', '--sidebar-muted'],
    ['--muted-foreground', '--sidebar-muted-foreground'],
    ['--accent', '--sidebar-accent'],
    ['--accent-foreground', '--sidebar-accent-foreground'],
    ['--border', '--sidebar-border'],
    ['--input', '--sidebar-border'],
    ['--primary', '--sidebar-primary'],
    ['--primary-foreground', '--sidebar-primary-foreground'],
    ['--ring', '--sidebar-ring'],
    ['--surface-active', '--accent']
  ] as const

  expect(materialDeclarations).toBeDefined()
  for (const [semanticToken, sidebarToken] of semanticMappings) {
    expect(materialDeclarations).toMatch(
      new RegExp(`${semanticToken}:\\s*var\\(${sidebarToken}\\);`, 'u')
    )
  }
})
