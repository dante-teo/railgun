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
import { useTranscript } from '@/hooks/use-transcript'
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
  const transcript = useTranscript()
  const [taskActionError, setTaskActionError] = useState<string>()
  const [archiveInFlight, setArchiveInFlight] = useState(false)
  const [archivingTaskId, setArchivingTaskId] = useState<string>()
  const [loadError, setLoadError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [createInFlight, setCreateInFlight] = useState(false)
  const [newlyPersistedTaskId, setNewlyPersistedTaskId] = useState<string>()
  const [restoredTaskId, setRestoredTaskId] = useState<string>()
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [unsavedTask, setUnsavedTask] = useState<Pick<TaskSummary, 'id' | 'title'>>()
  const activeDetailSessionId = useRef<string | undefined>(undefined)
  const archiveLock = useRef(false)
  const archiveOperation = useRef<ArchiveOperation | undefined>(undefined)
  const createLock = useRef(false)
  const selectionAttempt = useRef(0)
  const taskListRequestSequence = useRef(0)
  const transcriptRunning = transcript.status === 'running'

  useEffect(() => {
    let cancelled = false
    const requestSequence = ++taskListRequestSequence.current
    void loadTasks().then(
      (loadedTasks) => {
        if (!cancelled && requestSequence === taskListRequestSequence.current) {
          setTasks(loadedTasks)
          setLoading(false)
        }
      },
      () => {
        if (!cancelled && requestSequence === taskListRequestSequence.current) {
          setLoadError(taskLoadError)
          setLoading(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const handleCreate = useCallback(async (): Promise<void> => {
    if (createLock.current || archiveLock.current || transcriptRunning) {
      return
    }

    createLock.current = true
    setCreateInFlight(true)
    setNewlyPersistedTaskId(undefined)
    setTaskActionError(undefined)
    try {
      const sessionId = await window.railgun.tasks.create()
      selectionAttempt.current += 1
      activeDetailSessionId.current = sessionId
      setSelectedTaskId(undefined)
      setUnsavedTask({ id: sessionId, title: 'New Task' })
    } catch {
      setTaskActionError('Could not create a new task. Try again.')
    } finally {
      createLock.current = false
      setCreateInFlight(false)
    }
  }, [transcriptRunning])

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

  const handleNewlyPersistedEntranceComplete = useCallback((sessionId: string): void => {
    setNewlyPersistedTaskId((current) => (current === sessionId ? undefined : current))
  }, [])

  const handleArchive = useCallback(
    async (sessionId: string): Promise<void> => {
      if (archiveLock.current || createLock.current || transcriptRunning) {
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
      setNewlyPersistedTaskId((current) => (current === sessionId ? undefined : current))
      setRestoredTaskId(undefined)
      if (operation.wasSelected) {
        activeDetailSessionId.current = undefined
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
          activeDetailSessionId.current = sessionId
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
    [finishArchiveExit, selectedTaskId, tasks, transcriptRunning]
  )

  const handleSelect = useCallback(
    (sessionId: string): void => {
      if (createLock.current || transcriptRunning) {
        return
      }
      const task = tasks.find((candidate) => candidate.id === sessionId)
      if (!task) {
        return
      }

      const attempt = ++selectionAttempt.current
      const previousDetailSessionId = activeDetailSessionId.current
      const previousSelection = selectedTaskId
      const previousUnsavedTask = unsavedTask
      activeDetailSessionId.current = sessionId
      setSelectedTaskId(sessionId)
      setUnsavedTask(undefined)
      setTaskActionError(undefined)
      void window.railgun.tasks.open(sessionId).catch(() => {
        if (selectionAttempt.current === attempt) {
          activeDetailSessionId.current = previousDetailSessionId
          setSelectedTaskId((current) => (current === sessionId ? previousSelection : current))
          setUnsavedTask(previousUnsavedTask)
          setTaskActionError(`Could not open “${task.title}”. Try again.`)
        }
      })
    },
    [selectedTaskId, tasks, transcriptRunning, unsavedTask]
  )

  const handleSessionChanged = useCallback((previousSessionId: string, sessionId: string): void => {
    if (previousSessionId === sessionId) {
      return
    }
    if (activeDetailSessionId.current === previousSessionId) {
      activeDetailSessionId.current = sessionId
    }
    setUnsavedTask((current) =>
      current?.id === previousSessionId ? { ...current, id: sessionId } : current
    )
    setTasks((current) =>
      current.map((task) => (task.id === previousSessionId ? { ...task, id: sessionId } : task))
    )
    setSelectedTaskId((current) => (current === previousSessionId ? sessionId : current))
  }, [])

  const handleTaskSaved = useCallback(
    (sessionId: string): void => {
      const requestSequence = ++taskListRequestSequence.current
      const reconcileUnsavedTask = unsavedTask?.id === sessionId
      void window.railgun.tasks.list().then(
        (loadedTasks) => {
          if (requestSequence !== taskListRequestSequence.current) {
            return
          }
          setTasks(loadedTasks)
          setLoading(false)
          if (reconcileUnsavedTask && activeDetailSessionId.current === sessionId) {
            const savedTask = loadedTasks.find((task) => task.id === sessionId)
            if (!savedTask) {
              setTaskActionError('The task was saved, but the task list could not be refreshed.')
              return
            }
            setUnsavedTask((current) => (current?.id === sessionId ? undefined : current))
            setNewlyPersistedTaskId(savedTask.id)
            setSelectedTaskId(savedTask.id)
          }
          setTaskActionError(undefined)
        },
        () => {
          if (requestSequence === taskListRequestSequence.current) {
            setLoading(false)
            setTaskActionError('The task was saved, but the task list could not be refreshed.')
          }
        }
      )
    },
    [unsavedTask]
  )

  const selectedTask = tasks.find((task) => task.id === selectedTaskId)
  const detailTask = unsavedTask ?? selectedTask

  return (
    <AppShellLayout
      content={
        <TaskList
          archivingTaskId={archivingTaskId}
          archiveDisabled={archiveInFlight || createInFlight || transcriptRunning}
          taskActionError={taskActionError}
          loadError={loadError}
          loading={loading}
          newlyPersistedTaskId={newlyPersistedTaskId}
          onArchive={(sessionId) => void handleArchive(sessionId)}
          onArchiveExit={handleArchiveExit}
          onNewlyPersistedEntranceComplete={handleNewlyPersistedEntranceComplete}
          onSelect={handleSelect}
          restoredTaskId={restoredTaskId}
          selectionDisabled={createInFlight || transcriptRunning}
          selectedTaskId={selectedTaskId}
          tasks={tasks}
        />
      }
      detail={
        <TaskDetailPlaceholder
          disabled={createInFlight}
          onSessionChanged={handleSessionChanged}
          onTaskSaved={handleTaskSaved}
          task={detailTask}
        />
      }
      inspector={<TaskInspector />}
      inspectorTopBar={<InspectorTopBar />}
      sidebar={<SidebarNavigation activity={activity} />}
      sidebarTopBar={<SidebarTopBar />}
      workspaceTopBar={
        <TasksWorkspaceTopBar
          createDisabled={archiveInFlight || transcriptRunning}
          creating={createInFlight}
          onCreateTask={() => void handleCreate()}
        />
      }
    />
  )
}
