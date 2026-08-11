import { useCallback, useEffect, useState } from 'react'

import { InlineError, SettingsDetail, SettingsLoading, SettingsSection } from './SettingsChrome'
import { SettingsCrossfade } from './SettingsMotion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle
} from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { AdvisorConfiguration } from '@/lib/advisor-api'
import type { ApprovalConfiguration, ApprovalMode } from '@/lib/approval-api'
import type { ModelConfiguration } from '@/lib/model-api'
import type { SchedulerStatus } from '@/lib/scheduler-api'

const noModelValue = '__automatic__'

function unavailableModelId(
  modelId: string | null,
  models: ModelConfiguration
): string | undefined {
  return modelId && !models.models.some(({ id }) => id === modelId) ? modelId : undefined
}

function ModelItems({
  models,
  unavailableId
}: {
  models: ModelConfiguration
  unavailableId?: string
}): React.JSX.Element {
  return (
    <>
      {unavailableId ? (
        <SelectGroup>
          <SelectItem value={unavailableId}>{unavailableId} (Unavailable)</SelectItem>
        </SelectGroup>
      ) : null}
      <SelectGroup>
        {models.models.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.name}
          </SelectItem>
        ))}
      </SelectGroup>
    </>
  )
}

const schedulerLabels: Record<SchedulerStatus['state'], string> = {
  'not-installed': 'Not installed',
  running: 'Running',
  stopped: 'Stopped',
  'repair-needed': 'Repair needed',
  unavailable: 'Unavailable'
}

export function GeneralSettings(): React.JSX.Element {
  const [models, setModels] = useState<ModelConfiguration>()
  const [advisor, setAdvisor] = useState<AdvisorConfiguration>()
  const [approval, setApproval] = useState<ApprovalConfiguration>()
  const [scheduler, setScheduler] = useState<SchedulerStatus>()
  const [configurationError, setConfigurationError] = useState<string>()
  const [schedulerError, setSchedulerError] = useState<string>()
  const [configurationBusy, setConfigurationBusy] = useState(false)
  const [schedulerBusy, setSchedulerBusy] = useState(false)
  const [loadSequence, setLoadSequence] = useState(0)

  const load = useCallback((): void => {
    setConfigurationError(undefined)
    setSchedulerError(undefined)
    setModels(undefined)
    setAdvisor(undefined)
    setApproval(undefined)
    setScheduler(undefined)
    setLoadSequence((current) => current + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.railgun.models.get(),
      window.railgun.advisor.get(),
      window.railgun.approval.get()
    ]).then(
      ([nextModels, nextAdvisor, nextApproval]) => {
        if (!cancelled) {
          setModels(nextModels)
          setAdvisor(nextAdvisor)
          setApproval(nextApproval)
        }
      },
      () => {
        if (!cancelled) setConfigurationError('Could not load model and permission settings.')
      }
    )
    void window.railgun.scheduler.getStatus().then(
      (status) => {
        if (!cancelled) setScheduler(status)
      },
      () => {
        if (!cancelled) setSchedulerError('Could not check Background Scheduling.')
      }
    )
    return () => {
      cancelled = true
    }
  }, [loadSequence])

  const configurationLocked = !models || !advisor || !approval || models.isRunning

  const mutateConfiguration = async (operation: () => Promise<void>): Promise<void> => {
    if (configurationBusy || configurationLocked) return
    setConfigurationBusy(true)
    setConfigurationError(undefined)
    try {
      await operation()
    } catch {
      setConfigurationError('The setting could not be saved. Your previous value is unchanged.')
    } finally {
      setConfigurationBusy(false)
    }
  }

  const changeAdvisorEnabled = (enabled: boolean): void => {
    if (!advisor || !models) return
    const nextModelId =
      models.models.find(({ id }) => id === advisor.modelId)?.id ?? models.models[0]?.id ?? null
    if (enabled && !nextModelId) {
      setConfigurationError('Add an available model before enabling Advisor.')
      return
    }
    void mutateConfiguration(async () => {
      setAdvisor(await window.railgun.advisor.set({ enabled, modelId: nextModelId }))
    })
  }

  const changeApprovalMode = (mode: string): void => {
    if (!approval || !models || !mode) return
    const selectedMode = mode as ApprovalMode
    const reviewerModelId =
      selectedMode === 'smart'
        ? (models.models.find(({ id }) => id === approval.reviewerModelId)?.id ??
          models.models[0]?.id ??
          null)
        : approval.reviewerModelId
    if (selectedMode === 'smart' && !reviewerModelId) {
      setConfigurationError('Add an available model before choosing Approve for me.')
      return
    }
    void mutateConfiguration(async () => {
      setApproval(await window.railgun.approval.set({ mode: selectedMode, reviewerModelId }))
    })
  }

  const runSchedulerAction = async (action: 'install' | 'uninstall'): Promise<void> => {
    if (schedulerBusy) return
    setSchedulerBusy(true)
    setSchedulerError(undefined)
    try {
      setScheduler(await window.railgun.scheduler[action]())
    } catch {
      setSchedulerError('Background Scheduling could not be changed. Its status was refreshed.')
      await window.railgun.scheduler.getStatus().then(setScheduler, () => undefined)
    } finally {
      setSchedulerBusy(false)
    }
  }

  return (
    <SettingsDetail
      description="Choose defaults for future work, approval behavior, and background execution."
      title="General"
    >
      {configurationError ? (
        <InlineError>
          {configurationError}{' '}
          {!models ? (
            <Button onClick={load} size="sm" variant="link">
              Retry
            </Button>
          ) : null}
        </InlineError>
      ) : null}

      <SettingsSection
        description="This affects new tasks only. The current task keeps its selected model."
        title="Default Model"
      >
        {!models ? (
          <SettingsCrossfade stateKey="loading">
            <SettingsLoading label="Model settings are loading" />
          </SettingsCrossfade>
        ) : (
          <SettingsCrossfade stateKey="ready">
            <FieldGroup>
              <Field data-disabled={configurationLocked || configurationBusy}>
                <FieldLabel htmlFor="default-model">Model for future tasks</FieldLabel>
                <Select
                  disabled={configurationLocked || configurationBusy}
                  onValueChange={(value) =>
                    void mutateConfiguration(async () => {
                      setModels(
                        await window.railgun.models.setDefault(
                          value === noModelValue ? null : value
                        )
                      )
                    })
                  }
                  value={models.defaultModelId ?? noModelValue}
                >
                  <SelectTrigger id="default-model">
                    <SelectValue placeholder="Choose a model" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={noModelValue}>First available model</SelectItem>
                    </SelectGroup>
                    <ModelItems
                      models={models}
                      unavailableId={unavailableModelId(models.defaultModelId, models)}
                    />
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Saved immediately and never switches the active task.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </SettingsCrossfade>
        )}
      </SettingsSection>

      <SettingsSection
        description="Adds a private second-model review to future runs."
        title="Advisor"
      >
        {!models || !advisor ? (
          <SettingsCrossfade stateKey="loading">
            <SettingsLoading label="Advisor settings are loading" />
          </SettingsCrossfade>
        ) : (
          <SettingsCrossfade stateKey="ready">
            <FieldGroup>
              <Field
                data-disabled={configurationLocked || configurationBusy}
                orientation="horizontal"
              >
                <FieldContent>
                  <FieldTitle>Enable Advisor</FieldTitle>
                  <FieldDescription>Requires an available model.</FieldDescription>
                </FieldContent>
                <Switch
                  aria-label="Enable Advisor"
                  checked={advisor.enabled}
                  disabled={configurationLocked || configurationBusy}
                  onCheckedChange={changeAdvisorEnabled}
                />
              </Field>
              <Field data-disabled={configurationLocked || configurationBusy}>
                <FieldLabel htmlFor="advisor-model">Advisor model</FieldLabel>
                <Select
                  disabled={configurationLocked || configurationBusy}
                  onValueChange={(modelId) =>
                    void mutateConfiguration(async () => {
                      setAdvisor(
                        await window.railgun.advisor.set({ enabled: advisor.enabled, modelId })
                      )
                    })
                  }
                  value={advisor.modelId ?? undefined}
                >
                  <SelectTrigger id="advisor-model">
                    <SelectValue placeholder="Choose a model" />
                  </SelectTrigger>
                  <SelectContent>
                    <ModelItems
                      models={models}
                      unavailableId={unavailableModelId(advisor.modelId, models)}
                    />
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
          </SettingsCrossfade>
        )}
      </SettingsSection>

      <SettingsSection
        description="Control when Railgun asks before privileged tool actions."
        title="Permissions"
      >
        {!models || !approval ? (
          <SettingsCrossfade stateKey="loading">
            <SettingsLoading label="Permission settings are loading" />
          </SettingsCrossfade>
        ) : (
          <SettingsCrossfade stateKey="ready">
            <FieldGroup>
              <Field>
                <FieldLabel>Approval mode</FieldLabel>
                <ToggleGroup
                  aria-label="Approval mode"
                  disabled={configurationLocked || configurationBusy}
                  onValueChange={changeApprovalMode}
                  type="single"
                  value={approval.mode}
                  variant="outline"
                >
                  <ToggleGroupItem value="manual">Ask for approval</ToggleGroupItem>
                  <ToggleGroupItem value="smart">Approve for me</ToggleGroupItem>
                  <ToggleGroupItem value="off">Full access</ToggleGroupItem>
                </ToggleGroup>
              </Field>
              <Field data-disabled={configurationLocked || configurationBusy}>
                <FieldLabel htmlFor="reviewer-model">Auto-approval model</FieldLabel>
                <Select
                  disabled={configurationLocked || configurationBusy}
                  onValueChange={(reviewerModelId) =>
                    void mutateConfiguration(async () => {
                      setApproval(
                        await window.railgun.approval.set({
                          mode: approval.mode,
                          reviewerModelId
                        })
                      )
                    })
                  }
                  value={approval.reviewerModelId ?? undefined}
                >
                  <SelectTrigger id="reviewer-model">
                    <SelectValue placeholder="Choose a reviewer model" />
                  </SelectTrigger>
                  <SelectContent>
                    <ModelItems
                      models={models}
                      unavailableId={unavailableModelId(approval.reviewerModelId, models)}
                    />
                  </SelectContent>
                </Select>
                <FieldDescription>Required for Approve for me.</FieldDescription>
              </Field>
            </FieldGroup>
          </SettingsCrossfade>
        )}
      </SettingsSection>

      <SettingsSection
        action={
          <SettingsCrossfade layout="inline" stateKey={scheduler?.state ?? 'checking'}>
            {scheduler ? (
              <Badge variant={scheduler.state === 'repair-needed' ? 'destructive' : 'secondary'}>
                {schedulerLabels[scheduler.state]}
              </Badge>
            ) : (
              <Badge variant="secondary">Checking</Badge>
            )}
          </SettingsCrossfade>
        }
        description="Run scheduled tasks from a private macOS LaunchAgent."
        title="Background Scheduling"
      >
        <SettingsCrossfade stateKey={scheduler?.state ?? 'checking'}>
          {!scheduler ? (
            <SettingsLoading label="Background Scheduling status is checking" />
          ) : (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                {scheduler.detail ?? 'Railgun checks and runs due schedules in the background.'}
              </p>
              {scheduler.state === 'running' ? (
                <Button
                  disabled={schedulerBusy}
                  onClick={() => void runSchedulerAction('uninstall')}
                  variant="outline"
                >
                  Uninstall
                </Button>
              ) : scheduler.state === 'repair-needed' ? (
                <Button disabled={schedulerBusy} onClick={() => void runSchedulerAction('install')}>
                  Repair
                </Button>
              ) : scheduler.state === 'not-installed' || scheduler.state === 'stopped' ? (
                <Button disabled={schedulerBusy} onClick={() => void runSchedulerAction('install')}>
                  Install
                </Button>
              ) : null}
            </div>
          )}
        </SettingsCrossfade>
        {schedulerError ? <InlineError>{schedulerError}</InlineError> : null}
      </SettingsSection>

      {models?.isRunning ? (
        <InlineError>
          Model, Advisor, and Permission settings are locked while a task runs.
        </InlineError>
      ) : null}
    </SettingsDetail>
  )
}
