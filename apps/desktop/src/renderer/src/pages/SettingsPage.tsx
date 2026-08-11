import { useCallback, useRef } from 'react'
import { Navigate, useParams } from 'react-router'

import { AppearanceSettings } from '@/components/settings/AppearanceSettings'
import { ArchivedTasksSettings } from '@/components/settings/ArchivedTasksSettings'
import { GeneralSettings } from '@/components/settings/GeneralSettings'
import { PersonalizationSettings } from '@/components/settings/PersonalizationSettings'
import {
  SettingsCategoryNavigation,
  SettingsWorkspaceTopBar
} from '@/components/settings/SettingsChrome'
import { SkillsSettings } from '@/components/settings/SkillsSettings'
import { SidebarNavigation } from '@/components/shell/SidebarNavigation'
import { SidebarTopBar } from '@/components/shell/ShellTopBars'
import { useActivity } from '@/hooks/use-activity'
import { isSettingsCategory, settingsCategories } from '@/lib/settings-route'
import { AppShellLayout } from '@/layouts/AppShellLayout'

export function SettingsPage(): React.JSX.Element {
  const activity = useActivity()
  const { category: categoryParameter } = useParams()
  const saveBeforeNavigation = useRef<() => Promise<boolean>>(async () => true)

  const registerSaveBeforeNavigation = useCallback((save?: () => Promise<boolean>): void => {
    saveBeforeNavigation.current = save ?? (async () => true)
  }, [])
  const attemptNavigation = useCallback(async (): Promise<boolean> => {
    return saveBeforeNavigation.current()
  }, [])

  if (!isSettingsCategory(categoryParameter)) {
    return <Navigate replace to="/settings/general" />
  }

  const title = settingsCategories.find(({ id }) => id === categoryParameter)?.label ?? 'Settings'
  const detail =
    categoryParameter === 'general' ? (
      <GeneralSettings />
    ) : categoryParameter === 'appearance' ? (
      <AppearanceSettings />
    ) : categoryParameter === 'personalization' ? (
      <PersonalizationSettings registerSaveBeforeNavigation={registerSaveBeforeNavigation} />
    ) : categoryParameter === 'skills' ? (
      <SkillsSettings registerSaveBeforeNavigation={registerSaveBeforeNavigation} />
    ) : (
      <ArchivedTasksSettings />
    )

  return (
    <AppShellLayout
      content={
        <SettingsCategoryNavigation category={categoryParameter} onNavigate={attemptNavigation} />
      }
      detail={detail}
      sidebar={
        <SidebarNavigation activity={activity} onNavigate={attemptNavigation} selected="settings" />
      }
      sidebarTopBar={<SidebarTopBar />}
      workspaceTopBar={<SettingsWorkspaceTopBar title={title} />}
    />
  )
}
