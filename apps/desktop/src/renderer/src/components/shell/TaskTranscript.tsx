import { Fragment, memo, useCallback, useEffect, useState } from 'react'
import { ArrowDownIcon, LoaderCircleIcon } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { useStickToBottom } from 'use-stick-to-bottom'

import { usePresence } from '@/hooks/use-presence'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { TaskSummary } from '@/lib/task-api'
import type {
  TranscriptAssistantMessage,
  TranscriptMessage,
  TranscriptSnapshot,
  TranscriptUserMessage
} from '@/lib/transcript-api'

import { TaskComposer } from './TaskComposer'
import { TaskInteractionRows } from './TaskInteractions'
import { transcriptDisplayRows } from './tool-activity'
import { ExplorationGroupRow, ToolUseRow } from './ToolUseRow'
import { TurnWorkRow } from './TurnWorkRow'
import styles from './TaskTranscript.module.css'

interface TaskTranscriptProps {
  onSessionChanged?: (previousSessionId: string, sessionId: string) => void
  onTaskSaved?: () => void
  snapshot: TranscriptSnapshot
  task: TaskSummary
}

const linkSafety = { enabled: true } as const
const criticalJumpSpring = {
  damping: (1 - Math.sqrt(0.05)) ** 2,
  stiffness: 0.05,
  mass: 1
} as const

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return reduced
}

const AssistantTranscriptMessage = memo(function AssistantTranscriptMessage({
  message
}: {
  message: TranscriptAssistantMessage
}): React.JSX.Element {
  const streaming = message.status === 'streaming'
  return (
    <Streamdown
      animated={false}
      className="w-full text-sm leading-7 text-foreground [&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:font-mono [&_code]:text-[0.9em] [&_h1]:mb-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_p]:text-justify [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted/50 [&_pre]:p-4 [&_pre]:text-left [&_table]:my-4 [&_table]:w-full [&_table]:text-left [&_td]:border-b [&_td]:p-2 [&_th]:border-b [&_th]:p-2 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6"
      controls={false}
      isAnimating={streaming}
      lineNumbers={false}
      linkSafety={linkSafety}
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      skipHtml
    >
      {message.text}
    </Streamdown>
  )
})

interface TranscriptTurn {
  readonly active: boolean
  readonly finalAssistant?: TranscriptAssistantMessage
  readonly kind: 'turn'
  readonly user: TranscriptUserMessage
  readonly work: readonly TranscriptMessage[]
}

interface StandaloneTranscriptMessage {
  readonly kind: 'standalone'
  readonly message: TranscriptMessage
}

type TranscriptSection = TranscriptTurn | StandaloneTranscriptMessage

function transcriptSections(
  messages: readonly TranscriptMessage[],
  running: boolean
): readonly TranscriptSection[] {
  const sections: TranscriptSection[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (message.role !== 'user') {
      sections.push({ kind: 'standalone', message })
      index += 1
      continue
    }

    let nextUserIndex = index + 1
    while (nextUserIndex < messages.length && messages[nextUserIndex].role !== 'user') {
      nextUserIndex += 1
    }
    const responses = messages.slice(index + 1, nextUserIndex)
    const active = running && nextUserIndex === messages.length
    const possibleFinal = active ? undefined : responses.at(-1)
    const finalAssistant =
      possibleFinal?.role === 'assistant' && possibleFinal.status !== 'streaming'
        ? possibleFinal
        : undefined
    sections.push({
      kind: 'turn',
      user: message,
      active,
      work: finalAssistant ? responses.slice(0, -1) : responses,
      ...(finalAssistant ? { finalAssistant } : {})
    })
    index = nextUserIndex
  }
  return sections
}

function TranscriptRow({
  animateCompletionOnMount = false,
  message
}: {
  animateCompletionOnMount?: boolean
  message: TranscriptMessage
}): React.JSX.Element {
  const [completionCue] = useState(animateCompletionOnMount)

  if (message.role === 'user') {
    return (
      <li className="ml-auto max-w-105" data-message-role="user">
        <article className="whitespace-pre-wrap break-words rounded-2xl border bg-card px-4 py-3 text-sm leading-6 shadow-minimal">
          {message.text}
        </article>
      </li>
    )
  }

  if (message.role === 'tool') {
    return <ToolUseRow message={message} />
  }

  return (
    <li
      className={cn('w-full', completionCue && styles.completionCue)}
      data-completion-cue={completionCue ? 'true' : undefined}
      data-message-role="assistant"
    >
      <article>
        <AssistantTranscriptMessage message={message} />
      </article>
    </li>
  )
}

function useCompletionCueTurnId(
  sessionId: string,
  snapshot: TranscriptSnapshot,
  sections: readonly TranscriptSection[]
): string | undefined {
  const snapshotMatchesSession = snapshot.sessionId === sessionId
  const turns = sections.filter((section): section is TranscriptTurn => section.kind === 'turn')
  const activeTurnIndex = snapshotMatchesSession ? turns.findIndex((turn) => turn.active) : -1
  const normalizedActiveTurnIndex = activeTurnIndex < 0 ? undefined : activeTurnIndex
  const [state, setState] = useState<{
    readonly activeTurnIndex?: number
    readonly completionCueTurnId?: string
    readonly sessionId: string
  }>(() => ({
    activeTurnIndex: normalizedActiveTurnIndex,
    sessionId
  }))
  if (state.sessionId !== sessionId || state.activeTurnIndex !== normalizedActiveTurnIndex) {
    const completedTurn =
      state.sessionId === sessionId &&
      state.activeTurnIndex !== undefined &&
      normalizedActiveTurnIndex === undefined
        ? turns[state.activeTurnIndex]
        : undefined
    setState({
      activeTurnIndex: normalizedActiveTurnIndex,
      completionCueTurnId: completedTurn?.finalAssistant ? completedTurn.user.id : undefined,
      sessionId
    })
  }

  return state.completionCueTurnId
}

function AgentWorkingIndicator(): React.JSX.Element {
  return (
    <li
      aria-atomic="true"
      aria-label="Agent is working"
      className="mr-auto flex max-w-105 items-center gap-2 text-xs text-muted-foreground"
      role="status"
    >
      <LoaderCircleIcon
        aria-hidden="true"
        className="size-3.5 animate-spin motion-reduce:animate-none"
      />
      <span>Agent is working…</span>
    </li>
  )
}

function JumpToLatestButton({
  onJump,
  present
}: {
  onJump: () => void
  present: boolean
}): React.JSX.Element | null {
  const presence = usePresence(present)
  if (!presence.mounted) {
    return null
  }

  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
      <Button
        aria-hidden={present ? undefined : true}
        className={cn('rounded-full shadow-minimal', styles.jumpToLatest)}
        data-present={present}
        inert={present ? undefined : true}
        onClick={onJump}
        onTransitionEnd={presence.handleTransitionEnd}
        size="sm"
        type="button"
        variant="secondary"
      >
        <ArrowDownIcon data-icon="inline-start" />
        Jump to latest
      </Button>
    </div>
  )
}

function TranscriptLoading(): React.JSX.Element {
  return (
    <div
      aria-label="Transcript is loading"
      className="mx-auto flex w-full max-w-180 flex-col gap-8 p-4"
      role="status"
    >
      <div className="ml-auto flex w-full max-w-105 flex-col gap-3 rounded-2xl border bg-card p-4">
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  )
}

function TranscriptContent({
  sessionId,
  snapshot
}: {
  sessionId: string
  snapshot: TranscriptSnapshot
}): React.JSX.Element {
  const sections = transcriptSections(snapshot.messages, snapshot.status === 'running')
  const completionCueTurnId = useCompletionCueTurnId(sessionId, snapshot, sections)

  if (
    snapshot.sessionId !== sessionId ||
    snapshot.status === 'idle' ||
    snapshot.status === 'loading'
  ) {
    return <TranscriptLoading />
  }

  if (snapshot.status === 'error') {
    return (
      <Empty className="min-h-full" role="alert">
        <EmptyHeader>
          <EmptyTitle>Transcript unavailable</EmptyTitle>
          <EmptyDescription>
            {snapshot.error ?? 'Could not load this transcript. Try reopening the task.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (snapshot.messages.length === 0 && snapshot.interactions.length === 0) {
    return (
      <Empty className={cn('min-h-full', styles.transcriptEmptyState)}>
        <EmptyHeader>
          <EmptyTitle>No messages yet</EmptyTitle>
          <EmptyDescription>Send a message to start this task.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const hasActiveTurn = sections.some((section) => section.kind === 'turn' && section.active)

  return (
    <ol
      aria-label="Task transcript"
      className="mx-auto flex min-h-full w-full max-w-180 flex-col justify-end gap-6 p-4"
      role="log"
    >
      {sections.map((section) =>
        section.kind === 'standalone' ? (
          <TranscriptRow key={section.message.id} message={section.message} />
        ) : (
          <Fragment key={section.user.id}>
            <TranscriptRow message={section.user} />
            {section.active || section.finalAssistant || section.work.length > 0 ? (
              <TurnWorkRow
                active={section.active}
                animateCompletionOnMount={completionCueTurnId === section.user.id}
                completedAt={section.finalAssistant?.completedAt}
                hasWork={section.work.length > 0 || section.active}
                key={`${section.user.id}-${section.active ? 'active' : 'complete'}`}
                startedAt={section.user.startedAt}
              >
                {transcriptDisplayRows(section.work).map((row) =>
                  row.kind === 'exploration' ? (
                    <ExplorationGroupRow key={row.id} messages={row.messages} />
                  ) : (
                    <TranscriptRow key={row.id} message={row.message} />
                  )
                )}
                {section.active ? (
                  <>
                    <TaskInteractionRows requests={snapshot.interactions} sessionId={sessionId} />
                    <AgentWorkingIndicator />
                  </>
                ) : null}
              </TurnWorkRow>
            ) : null}
            {section.finalAssistant ? (
              <TranscriptRow
                animateCompletionOnMount={completionCueTurnId === section.user.id}
                message={section.finalAssistant}
              />
            ) : null}
          </Fragment>
        )
      )}
      {!hasActiveTurn ? (
        <>
          <TaskInteractionRows requests={snapshot.interactions} sessionId={sessionId} />
          {snapshot.status === 'running' ? <AgentWorkingIndicator /> : null}
        </>
      ) : null}
    </ol>
  )
}

export function TaskTranscript({
  onSessionChanged,
  onTaskSaved,
  snapshot,
  task
}: TaskTranscriptProps): React.JSX.Element {
  const reducedMotion = useReducedMotion()
  const { contentRef, isAtBottom, scrollRef, scrollToBottom } = useStickToBottom({
    initial: 'instant',
    resize: 'instant'
  })

  const resumeFollowing = useCallback((): void => {
    void scrollToBottom({ animation: 'instant', ignoreEscapes: true })
  }, [scrollToBottom])

  const jumpToLatest = useCallback((): void => {
    void scrollToBottom({
      animation: reducedMotion ? 'instant' : criticalJumpSpring,
      ignoreEscapes: true
    })
  }, [reducedMotion, scrollToBottom])

  return (
    <section aria-label={`Transcript for ${task.title}`} className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-y-auto" data-slot="transcript-scroll" ref={scrollRef}>
          <div className="min-h-full" ref={contentRef}>
            <TranscriptContent sessionId={task.id} snapshot={snapshot} />
          </div>
        </div>
        <JumpToLatestButton onJump={jumpToLatest} present={!isAtBottom} />
      </div>
      <div className="w-full shrink-0 px-4 pb-4 pt-2">
        <div className="mx-auto w-full max-w-180">
          <TaskComposer
            onSessionChanged={(sessionId) => onSessionChanged?.(task.id, sessionId)}
            onSubmissionAccepted={resumeFollowing}
            onSubmissionCompleted={onTaskSaved}
            sessionId={task.id}
            transcript={snapshot}
          />
        </div>
      </div>
    </section>
  )
}
