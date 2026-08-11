import { useEffect, useRef, useState } from 'react'
import { ArrowUpIcon, FileIcon, FolderIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { ComposerAttachment } from '@/lib/attachment-api'
import type { ApprovalConfiguration, ApprovalMode } from '@/lib/approval-api'
import { useContextUsage } from '@/hooks/use-context-usage'
import { usePresence } from '@/hooks/use-presence'
import type { ModelConfiguration } from '@/lib/model-api'
import {
  projectTranscriptPrompt,
  type TranscriptSnapshot,
  type TranscriptSubmission
} from '@/lib/transcript-api'
import { cn } from '@/lib/utils'

import { ContextRing } from './ContextRing'
import { ApprovalModeSelector, ModelSelector } from './TaskComposerSelectors'
import styles from './TaskComposer.module.css'

interface TaskComposerProps {
  approvalExpanded?: boolean
  disabled?: boolean
  modelExpanded?: boolean
  onSessionChanged?: (sessionId: string) => void
  onSubmissionAccepted?: () => void
  onSubmissionCompleted?: () => void
  sessionId?: string
  sending?: boolean
  transcript?: TranscriptSnapshot
}

type SendState = 'idle' | 'sending'

interface SendGlyphProps {
  children: React.ReactNode
  state: SendState
}

function mergeAttachments(
  current: readonly ComposerAttachment[],
  selected: readonly ComposerAttachment[]
): readonly ComposerAttachment[] {
  return [
    ...new Map(
      [...current, ...selected].map((attachment) => [attachment.path, attachment])
    ).values()
  ]
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function prepareSubmission(
  draft: string,
  attachments: readonly ComposerAttachment[]
): { submission?: TranscriptSubmission; validationError?: string } {
  if (draft.trim().length === 0) {
    return {}
  }

  const submission = { text: draft, attachments }
  try {
    projectTranscriptPrompt(submission)
    return { submission }
  } catch (error) {
    return { validationError: errorMessage(error, 'The message is invalid') }
  }
}

function AttachmentChip({
  attachment,
  disabled,
  onExited,
  onRemove,
  present
}: {
  attachment: ComposerAttachment
  disabled: boolean
  onExited: (path: string) => void
  onRemove: (path: string) => void
  present: boolean
}): React.JSX.Element | null {
  const AttachmentIcon = attachment.kind === 'folder' ? FolderIcon : FileIcon
  const presence = usePresence(present, () => onExited(attachment.path))

  if (!presence.mounted) {
    return null
  }

  return (
    <li
      aria-hidden={present ? undefined : true}
      className="min-w-0 max-w-52"
      data-present={present}
      data-slot="task-composer-attachment"
      inert={present ? undefined : true}
      onTransitionEnd={presence.handleTransitionEnd}
    >
      <Button
        aria-label={`Remove ${attachment.kind} ${attachment.name}`}
        className="w-full min-w-0"
        disabled={disabled}
        onClick={() => onRemove(attachment.path)}
        size="sm"
        title={attachment.path}
        type="button"
        variant="secondary"
      >
        <AttachmentIcon data-icon="inline-start" />
        <span className="truncate">{attachment.name}</span>
        <XIcon data-icon="inline-end" />
      </Button>
    </li>
  )
}

function ComposerAlert({ message }: { message?: string }): React.JSX.Element | null {
  const [displayedMessage, setDisplayedMessage] = useState({ content: message, source: message })
  const present = message !== undefined
  const presence = usePresence(present)

  if (displayedMessage.source !== message) {
    setDisplayedMessage({
      content: message ?? displayedMessage.content,
      source: message
    })
  }
  const content = message ?? displayedMessage.content
  if (!presence.mounted || content === undefined) {
    return null
  }

  return (
    <p
      aria-hidden={present ? undefined : true}
      className="px-2 text-xs text-destructive"
      data-present={present}
      data-slot="task-composer-error"
      inert={present ? undefined : true}
      onTransitionEnd={presence.handleTransitionEnd}
      role="alert"
    >
      {content}
    </p>
  )
}

function SendGlyph({ children, state }: SendGlyphProps): React.JSX.Element {
  return (
    <span
      className="absolute inset-0 flex items-center justify-center"
      data-glyph={state}
      data-slot="task-composer-send-glyph"
    >
      {children}
    </span>
  )
}

export function TaskComposer({
  approvalExpanded,
  disabled = false,
  modelExpanded,
  onSessionChanged,
  onSubmissionAccepted,
  onSubmissionCompleted,
  sessionId,
  sending = false,
  transcript
}: TaskComposerProps = {}): React.JSX.Element {
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([])
  const [departingAttachmentPaths, setDepartingAttachmentPaths] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [attachmentError, setAttachmentError] = useState<string>()
  const [approval, setApproval] = useState<ApprovalConfiguration>()
  const [approvalBusy, setApprovalBusy] = useState(true)
  const [approvalError, setApprovalError] = useState<string>()
  const [models, setModels] = useState<ModelConfiguration>()
  const [modelBusy, setModelBusy] = useState(true)
  const [modelError, setModelError] = useState<string>()
  const [pickingAttachments, setPickingAttachments] = useState(false)
  const [draft, setDraft] = useState('')
  const [sendPending, setSendPending] = useState(false)
  const [sendError, setSendError] = useState<string>()
  const [stopping, setStopping] = useState(false)
  const composing = useRef(false)
  const contextUsage = useContextUsage()
  const transcriptMatches = Boolean(sessionId && transcript?.sessionId === sessionId)
  const transcriptRunning = transcriptMatches && transcript?.status === 'running'
  const isRunning = sending || transcriptRunning || sendPending
  const transcriptReady = transcriptMatches && transcript?.status === 'ready'
  const sendState: SendState = isRunning ? 'sending' : 'idle'
  const activeAttachments = attachments.filter(({ path }) => !departingAttachmentPaths.has(path))
  const stopBusy = stopping && isRunning
  const { submission, validationError } = prepareSubmission(draft, activeAttachments)
  const canSend = !disabled && transcriptReady && submission !== undefined && !isRunning
  const controlsDisabled = disabled || isRunning

  useEffect(() => {
    let cancelled = false
    void window.railgun.approval.get().then(
      (configuration) => {
        if (!cancelled) {
          setApproval(configuration)
          setApprovalBusy(false)
        }
      },
      () => {
        if (!cancelled) {
          setApprovalError('Could not load approval mode. Try reopening the task.')
          setApprovalBusy(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.railgun.models.get().then(
      (configuration) => {
        if (!cancelled) {
          setModels(configuration)
          setModelBusy(false)
        }
      },
      () => {
        if (!cancelled) {
          setModelError('Could not load models. Try reopening the task.')
          setModelBusy(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const handleAddAttachment = async (): Promise<void> => {
    if (pickingAttachments || controlsDisabled) {
      return
    }

    setAttachmentError(undefined)
    setPickingAttachments(true)
    try {
      const selected = await window.railgun.attachments.pick()
      setAttachments((current) => mergeAttachments(current, selected))
    } catch {
      setAttachmentError('Could not add attachments. Try again.')
    } finally {
      setPickingAttachments(false)
    }
  }

  const handleRemoveAttachment = (path: string): void => {
    if (controlsDisabled) {
      return
    }
    setDepartingAttachmentPaths((current) =>
      current.has(path) ? current : new Set([...current, path])
    )
  }

  const handleAttachmentExited = (path: string): void => {
    setAttachments((current) => current.filter((attachment) => attachment.path !== path))
    setDepartingAttachmentPaths(
      (current) => new Set([...current].filter((departingPath) => departingPath !== path))
    )
  }

  const handleApprovalModeChange = async (mode: ApprovalMode): Promise<void> => {
    if (disabled || !approval || approvalBusy || isRunning || mode === approval.mode) {
      return
    }
    if (mode === 'smart' && approval.reviewerModelId === null) {
      setApprovalError('Choose an approval model before enabling auto approval.')
      return
    }

    setApprovalError(undefined)
    setApprovalBusy(true)
    try {
      setApproval(await window.railgun.approval.setMode(mode))
    } catch {
      setApprovalError('Could not update approval mode. Try again.')
    } finally {
      setApprovalBusy(false)
    }
  }

  const handleModelChange = async (modelId: string): Promise<void> => {
    const selected = models?.models.find(({ id }) => id === modelId)
    if (
      disabled ||
      !models ||
      !selected ||
      modelBusy ||
      models.isRunning ||
      isRunning ||
      modelId === models.activeModelId
    ) {
      return
    }

    setModelError(undefined)
    setModelBusy(true)
    let changedSessionId: string | undefined
    try {
      const configuration = await window.railgun.models.select(selected.id)
      setModels(configuration)
      setModelError(configuration.warning ?? undefined)
      if (sessionId && configuration.activeSessionId !== sessionId) {
        changedSessionId = configuration.activeSessionId
      }
    } catch {
      setModelError('Could not update the model. Try again.')
    } finally {
      setModelBusy(false)
    }
    if (changedSessionId) {
      onSessionChanged?.(changedSessionId)
    }
  }

  const handleSend = async (): Promise<void> => {
    if (!sessionId || !submission || !canSend) {
      return
    }
    const accepted = submission
    setSendError(undefined)
    setStopping(false)
    setSendPending(true)
    setDraft('')
    setAttachments([])
    setDepartingAttachmentPaths(new Set())
    onSubmissionAccepted?.()
    try {
      await window.railgun.transcript.send(sessionId, accepted)
    } catch (error) {
      setDraft(accepted.text)
      setAttachments(accepted.attachments)
      setSendError(errorMessage(error, 'Could not send the message. Try again.'))
      return
    } finally {
      setSendPending(false)
    }
    onSubmissionCompleted?.()
  }

  const handleAbort = async (): Promise<void> => {
    if (!sessionId || stopping || !isRunning) {
      return
    }
    setSendError(undefined)
    setStopping(true)
    try {
      await window.railgun.transcript.abort(sessionId)
    } catch (error) {
      setStopping(false)
      setSendError(errorMessage(error, 'Could not stop the response. Try again.'))
    }
  }

  const handleMessageKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      composing.current ||
      event.nativeEvent.isComposing
    ) {
      return
    }
    event.preventDefault()
    if (canSend) {
      void handleSend()
    }
  }

  return (
    <div
      aria-label="Message composer"
      className={cn('relative isolate w-full rounded-3xl', styles.composer)}
      data-slot="task-composer"
      role="group"
    >
      <div
        aria-hidden="true"
        className="absolute inset-1 z-0 overflow-hidden rounded-[inherit] blur-md"
        data-slot="task-composer-glow"
      >
        <div data-slot="task-composer-spectrum" />
      </div>
      <div
        className="relative z-10 flex w-full flex-col gap-2 rounded-[inherit] bg-card p-2 ring-1 ring-foreground/10"
        data-slot="task-composer-surface"
      >
        <textarea
          aria-label="Message"
          className="min-h-10 max-h-64 w-full resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm leading-6 text-foreground outline-none field-sizing-content placeholder:text-muted-foreground"
          disabled={controlsDisabled}
          onChange={(event) => {
            setDraft(event.target.value)
            setSendError(undefined)
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          onCompositionStart={() => {
            composing.current = true
          }}
          onKeyDown={handleMessageKeyDown}
          placeholder="Message"
          rows={1}
          value={draft}
        />
        {attachments.length > 0 ? (
          <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-2">
            {attachments.map((attachment) => (
              <AttachmentChip
                attachment={attachment}
                disabled={controlsDisabled}
                key={attachment.path}
                onExited={handleAttachmentExited}
                onRemove={handleRemoveAttachment}
                present={!departingAttachmentPaths.has(attachment.path)}
              />
            ))}
          </ul>
        ) : null}
        <ComposerAlert message={attachmentError} />
        <ComposerAlert message={approvalError} />
        <ComposerAlert message={modelError} />
        <ComposerAlert message={validationError} />
        <ComposerAlert message={sendError} />
        <div
          aria-label="Composer controls"
          className="flex items-center gap-2"
          data-slot="task-composer-toolbar"
          role="group"
        >
          <Button
            aria-label="Add attachment"
            disabled={pickingAttachments || controlsDisabled}
            onClick={() => void handleAddAttachment()}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <PlusIcon data-icon="inline-start" />
          </Button>
          <ApprovalModeSelector
            approval={approval}
            busy={approvalBusy}
            disabled={controlsDisabled}
            expanded={approvalExpanded}
            onModeChange={(mode) => void handleApprovalModeChange(mode)}
          />
          <span aria-hidden="true" className="flex-1" data-slot="task-composer-spacer" />
          <ContextRing
            contextWindow={contextUsage.contextWindow}
            usedTokens={contextUsage.usedTokens}
          />
          <ModelSelector
            busy={modelBusy}
            configuration={models}
            disabled={controlsDisabled}
            expanded={modelExpanded}
            onModelChange={(modelId) => void handleModelChange(modelId)}
          />
          <Button
            aria-label={sendState === 'sending' ? 'Stop generation' : 'Send message'}
            aria-busy={stopBusy || undefined}
            className="rounded-full"
            data-composer-send=""
            data-state={sendState}
            disabled={sendState === 'sending' ? stopBusy : !canSend}
            onClick={() => void (sendState === 'sending' ? handleAbort() : handleSend())}
            size="icon-sm"
            type="button"
          >
            <span aria-hidden="true" className="relative size-4">
              <SendGlyph state="idle">
                <ArrowUpIcon data-icon="inline-start" />
              </SendGlyph>
              <SendGlyph state="sending">
                <SquareIcon className="fill-current" data-icon="inline-start" />
              </SendGlyph>
            </span>
          </Button>
        </div>
      </div>
    </div>
  )
}
