import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { ThemeProvider, applyTheme, readThemeMode, useTheme } from '@/lib/theme'

const themeStyles = readFileSync(resolve(process.cwd(), 'src/renderer/src/assets/main.css'), 'utf8')

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

it('defines every custom semantic surface token in dark mode', () => {
  const darkDeclarations = themeStyles.match(/\.dark\s*\{([\s\S]*?)\}/u)?.[1]

  expect(darkDeclarations).toBeDefined()
  for (const token of ['--canvas', '--surface-active', '--subtle-foreground', '--placeholder']) {
    expect(darkDeclarations).toMatch(new RegExp(`${token}:\\s*[^;]+;`, 'u'))
  }
})
