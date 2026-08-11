import { Check, Monitor, Moon, Sun } from 'lucide-react'

import { SettingsDetail, SettingsSection } from './SettingsChrome'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTheme, type ThemeMode } from '@/lib/theme'
import { cn } from '@/lib/utils'

const choices = [
  { id: 'auto', label: 'Auto', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon }
] as const

function ThemePreview({
  mode,
  selected
}: {
  mode: ThemeMode
  selected: boolean
}): React.JSX.Element {
  const dark = mode === 'dark'
  return (
    <div
      aria-hidden="true"
      className={cn(
        'relative flex h-24 w-full overflow-hidden rounded-lg border p-2 transition-[border-color,box-shadow] duration-(--duration-feedback) ease-(--ease-out)',
        dark ? 'bg-neutral-900' : 'bg-neutral-100',
        selected && 'border-primary ring-2 ring-primary/20'
      )}
    >
      {mode === 'auto' ? (
        <>
          <div className="absolute inset-y-0 left-0 w-1/2 bg-neutral-100" />
          <div className="absolute inset-y-0 right-0 w-1/2 bg-neutral-900" />
        </>
      ) : null}
      <div className="relative z-10 h-full w-1/3 rounded-md bg-neutral-300/80" />
      <div className="relative z-10 ml-2 flex flex-1 flex-col gap-2 pt-1">
        <div className="h-2 w-3/4 rounded-full bg-neutral-400/70" />
        <div className="h-2 w-full rounded-full bg-neutral-400/50" />
        <div className="mt-auto h-7 rounded-md bg-neutral-500/30" />
      </div>
      {selected ? (
        <span className="absolute right-2 top-2 z-20 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check />
        </span>
      ) : null}
    </div>
  )
}

export function AppearanceSettings(): React.JSX.Element {
  const { mode, resolved, setMode } = useTheme()
  return (
    <SettingsDetail
      description="Choose how Railgun looks. Auto follows macOS as it changes."
      title="Appearance"
    >
      <SettingsSection
        description={`Changes apply immediately across the app. Auto is currently using ${resolved}.`}
        title="Theme"
      >
        <ToggleGroup
          aria-label="Application theme"
          className="grid w-full grid-cols-3 gap-3"
          onValueChange={(value) => {
            if (value) setMode(value as ThemeMode)
          }}
          type="single"
          value={mode}
        >
          {choices.map(({ id, label, icon: Icon }) => (
            <ToggleGroupItem
              aria-label={label}
              className="h-auto min-w-0 flex-col items-stretch gap-2 p-2 data-[state=on]:bg-transparent"
              key={id}
              value={id}
            >
              <ThemePreview mode={id} selected={mode === id} />
              <span className="flex items-center justify-center gap-2 text-sm font-medium">
                <Icon />
                {label}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingsSection>
    </SettingsDetail>
  )
}
