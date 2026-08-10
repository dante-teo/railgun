import { useCallback, useEffect, useRef, useState } from 'react'

import { SidebarNavigation } from '@/components/shell/SidebarNavigation'
import {
  InspectorTopBar,
  SidebarTopBar,
  TasksWorkspaceTopBar
} from '@/components/shell/ShellTopBars'
import { TaskDetailPlaceholder } from '@/components/shell/TaskDetailPlaceholder'
import { TaskInspector } from '@/components/shell/TaskInspector'
import { TaskList } from '@/components/shell/TaskList'
import { useActivity } from '@/hooks/use-activity'
import { transitionEndFallbackMilliseconds } from '@/lib/motion'
import type { TaskSummary } from '@/lib/task-api'
import { AppShellLayout } from '@/layouts/AppShellLayout'

const taskLoadError = 'Could not load tasks. Check the backend and try again.'
let pendingTaskList: Promise<TaskSummary[]> | undefined

interface ArchiveOperation {
  exitComplete: Promise<void>
  exitCompleted: boolean
  exitFallback?: ReturnType<typeof setTimeout>
  originalIndex: number
  resolveExit: () => void
  sessionId: string
  task: TaskSummary
  wasSelected: boolean
}

function clearArchiveExitFallback(operation: ArchiveOperation): void {
  if (operation.exitFallback !== undefined) {
    clearTimeout(operation.exitFallback)
    operation.exitFallback = undefined
  }
}

function loadTasks(): Promise<TaskSummary[]> {
  if (!pendingTaskList) {
    pendingTaskList = window.railgun.tasks.list()
    void pendingTaskList.then(
      () => {
        pendingTaskList = undefined
      },
      () => {
        pendingTaskList = undefined
      }
    )
  }
  return pendingTaskList
}

export function TasksPage(): React.JSX.Element {
  const activity = useActivity()
  const [taskActionError, setTaskActionError] = useState<string>()
  const [archiveInFlight, setArchiveInFlight] = useState(false)
  const [archivingTaskId, setArchivingTaskId] = useState<string>()
  const [loadError, setLoadError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [restoredTaskId, setRestoredTaskId] = useState<string>()
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const archiveLock = useRef(false)
  const archiveOperation = useRef<ArchiveOperation | undefined>(undefined)
  const selectionAttempt = useRef(0)

  useEffect(() => {
    let cancelled = false
    void loadTasks().then(
      (loadedTasks) => {
        if (!cancelled) {
          setTasks(loadedTasks)
          setLoading(false)
        }
      },
      () => {
        if (!cancelled) {
          setLoadError(taskLoadError)
          setLoading(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const finishArchiveExit = useCallback((operation: ArchiveOperation): void => {
    if (archiveOperation.current !== operation || operation.exitCompleted) {
      return
    }

    operation.exitCompleted = true
    clearArchiveExitFallback(operation)
    setTasks((current) => current.filter((task) => task.id !== operation.sessionId))
    operation.resolveExit()
  }, [])

  const handleArchiveExit = useCallback(
    (sessionId: string): void => {
      const operation = archiveOperation.current
      if (operation?.sessionId === sessionId) {
        finishArchiveExit(operation)
      }
    },
    [finishArchiveExit]
  )

  const handleArchive = useCallback(
    async (sessionId: string): Promise<void> => {
      if (archiveLock.current) {
        return
      }

      const originalIndex = tasks.findIndex((task) => task.id === sessionId)
      const task = tasks[originalIndex]
      if (!task) {
        return
      }

      let resolveExit = (): void => undefined
      const exitComplete = new Promise<void>((resolve) => {
        resolveExit = resolve
      })
      const operation: ArchiveOperation = {
        exitComplete,
        exitCompleted: false,
        originalIndex,
        resolveExit,
        sessionId,
        task,
        wasSelected: selectedTaskId === sessionId
      }

      archiveLock.current = true
      archiveOperation.current = operation
      setArchiveInFlight(true)
      setTaskActionError(undefined)
      setArchivingTaskId(sessionId)
      setRestoredTaskId(undefined)
      if (operation.wasSelected) {
        setSelectedTaskId(undefined)
      }
      operation.exitFallback = setTimeout(
        () => finishArchiveExit(operation),
        transitionEndFallbackMilliseconds
      )

      try {
        await window.railgun.tasks.archive(sessionId)
        await operation.exitComplete
      } catch {
        if (operation.exitCompleted) {
          setTasks((current) => {
            if (current.some((candidate) => candidate.id === sessionId)) {
              return current
            }
            const insertionIndex = Math.min(operation.originalIndex, current.length)
            return [
              ...current.slice(0, insertionIndex),
              operation.task,
              ...current.slice(insertionIndex)
            ]
          })
          setRestoredTaskId(sessionId)
        }
        if (operation.wasSelected) {
          setSelectedTaskId((current) => current ?? sessionId)
        }
        setTaskActionError(`Could not archive “${operation.task.title}”. Try again.`)
      } finally {
        clearArchiveExitFallback(operation)
        operation.resolveExit()
        if (archiveOperation.current === operation) {
          archiveOperation.current = undefined
          archiveLock.current = false
          setArchivingTaskId(undefined)
          setArchiveInFlight(false)
        }
      }
    },
    [finishArchiveExit, selectedTaskId, tasks]
  )

  const handleSelect = useCallback(
    (sessionId: string): void => {
      const task = tasks.find((candidate) => candidate.id === sessionId)
      if (!task) {
        return
      }

      const attempt = ++selectionAttempt.current
      const previousSelectedTaskId = selectedTaskId
      setSelectedTaskId(sessionId)
      setTaskActionError(undefined)
      void window.railgun.tasks.open(sessionId).catch(() => {
        if (selectionAttempt.current === attempt) {
          setSelectedTaskId(previousSelectedTaskId)
          setTaskActionError(`Could not open “${task.title}”. Try again.`)
        }
      })
    },
    [selectedTaskId, tasks]
  )

  const selectedTask = tasks.find((task) => task.id === selectedTaskId)

  return (
    <AppShellLayout
      content={
        <TaskList
          archivingTaskId={archivingTaskId}
          archiveDisabled={archiveInFlight}
          taskActionError={taskActionError}
          loadError={loadError}
          loading={loading}
          onArchive={(sessionId) => void handleArchive(sessionId)}
          onArchiveExit={handleArchiveExit}
          onSelect={handleSelect}
          restoredTaskId={restoredTaskId}
          selectedTaskId={selectedTaskId}
          tasks={tasks}
        />
      }
      detail={<TaskDetailPlaceholder task={selectedTask} />}
      inspector={<TaskInspector />}
      inspectorTopBar={<InspectorTopBar />}
      sidebar={<SidebarNavigation activity={activity} />}
      sidebarTopBar={<SidebarTopBar />}
      workspaceTopBar={<TasksWorkspaceTopBar />}
    />
  )
}
