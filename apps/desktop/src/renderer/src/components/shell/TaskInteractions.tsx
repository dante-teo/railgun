import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import {
  declinedClarificationAnswer,
  maximumClarificationAnswerLength,
  type TranscriptApprovalRequest,
  type TranscriptClarificationRequest,
  type TranscriptInteractionRequest
} from '@/lib/transcript-api'
import { usePresence } from '@/hooks/use-presence'
import { cn } from '@/lib/utils'

interface InteractionRowsProps {
  requests: readonly TranscriptInteractionRequest[]
  sessionId: string
}

interface InteractionRequestProps {
  onExited: (requestId: string) => void
  primary: boolean
  present: boolean
  request: TranscriptInteractionRequest
  sessionId: string
}

interface InteractionStatusValue {
  key: string
  label: string
  role: 'alert' | 'status'
  tone: 'destructive' | 'muted'
}

interface InteractionStatusLayerState extends InteractionStatusValue {
  entering: boolean
  id: number
  present: boolean
}

interface InteractionStatusState {
  key?: string
  layers: readonly InteractionStatusLayerState[]
  nextLayerId: number
}

function interactionStatusValue(
  request: TranscriptInteractionRequest
): InteractionStatusValue | undefined {
  if (request.status === 'responding') {
    return {
      key: 'responding',
      label: 'Submitting response…',
      role: 'status',
      tone: 'muted'
    }
  }
  return request.error
    ? {
        key: `error:${request.error}`,
        label: request.error,
        role: 'alert',
        tone: 'destructive'
      }
    : undefined
}

function InteractionStatusLayer({
  layer,
  onExited
}: {
  layer: InteractionStatusLayerState
  onExited: (id: number) => void
}): React.JSX.Element | null {
  const finishExit = useCallback(() => onExited(layer.id), [layer.id, onExited])
  const { mounted, handleTransitionEnd } = usePresence(layer.present, finishExit)
  if (!mounted) {
    return null
  }

  return (
    <p
      aria-hidden={layer.present ? undefined : true}
      className={cn(
        'col-start-1 row-start-1 self-center text-xs opacity-100 transition-opacity duration-(--duration-feedback) ease-(--ease-out) starting:data-[entering=true]:opacity-0 data-[present=false]:pointer-events-none data-[present=false]:opacity-0 data-[present=false]:duration-100 motion-reduce:transition-opacity! motion-reduce:duration-(--duration-feedback)!',
        layer.tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'
      )}
      data-entering={layer.entering || undefined}
      data-present={layer.present}
      data-slot="interaction-status-layer"
      inert={layer.present ? undefined : true}
      onTransitionEnd={handleTransitionEnd}
      role={layer.present ? layer.role : undefined}
    >
      {layer.label}
    </p>
  )
}

function InteractionStatus({
  request
}: {
  request: TranscriptInteractionRequest
}): React.JSX.Element {
  const status = interactionStatusValue(request)
  const [state, setState] = useState<InteractionStatusState>(() => ({
    key: status?.key,
    layers: status ? [{ ...status, entering: false, id: 0, present: true }] : [],
    nextLayerId: 1
  }))
  if (state.key !== status?.key) {
    setState({
      key: status?.key,
      layers: [
        ...state.layers.map((layer) => ({ ...layer, present: false })),
        ...(status ? [{ ...status, entering: true, id: state.nextLayerId, present: true }] : [])
      ],
      nextLayerId: state.nextLayerId + (status ? 1 : 0)
    })
  }

  const removeExitedLayer = useCallback((id: number): void => {
    setState((current) => ({
      ...current,
      layers: current.layers.filter((layer) => layer.id !== id)
    }))
  }, [])

  return (
    <div className="grid min-h-5" data-slot="interaction-status">
      {state.layers.map((layer) => (
        <InteractionStatusLayer key={layer.id} layer={layer} onExited={removeExitedLayer} />
      ))}
    </div>
  )
}

function ApprovalRequest({
  primary,
  request,
  sessionId
}: {
  primary: boolean
  request: TranscriptApprovalRequest
  sessionId: string
}): React.JSX.Element {
  const denyRef = useRef<HTMLButtonElement>(null)
  const responding = request.status === 'responding'

  useEffect(() => {
    if (primary) {
      denyRef.current?.focus()
    }
  }, [primary])

  const respond = (approved: boolean): void => {
    void window.railgun.transcript
      .respondToApproval(sessionId, request.id, approved)
      .catch(() => undefined)
  }

  return (
    <Card
      aria-label="Approval request"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !responding) {
          event.preventDefault()
          respond(false)
        }
      }}
      role="group"
      size="sm"
    >
      <CardHeader>
        <CardTitle>Approval required</CardTitle>
        <CardDescription>Allow this protected action?</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <pre
          aria-label="Protected action preview"
          className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-left font-mono text-xs"
        >
          {request.command}
        </pre>
        <InteractionStatus request={request} />
      </CardContent>
      <CardFooter className="gap-2">
        <Button
          disabled={responding}
          onClick={() => respond(false)}
          ref={denyRef}
          size="sm"
          type="button"
          variant="destructive"
        >
          Deny
        </Button>
        <Button disabled={responding} onClick={() => respond(true)} size="sm" type="button">
          Allow
        </Button>
      </CardFooter>
    </Card>
  )
}

function ClarificationRequest({
  primary,
  request,
  sessionId
}: {
  primary: boolean
  request: TranscriptClarificationRequest
  sessionId: string
}): React.JSX.Element {
  const [answer, setAnswer] = useState(request.choices[0] ?? '')
  const answerControlRef = useRef<HTMLElement>(null)
  const responding = request.status === 'responding'
  const validAnswer = answer.trim().length > 0

  useEffect(() => {
    if (primary) {
      answerControlRef.current?.focus()
    }
  }, [primary])

  const respond = (value: string): void => {
    void window.railgun.transcript
      .respondToClarification(sessionId, request.id, value)
      .catch(() => undefined)
  }
  const submit = (): void => {
    if (!responding && validAnswer) {
      respond(answer)
    }
  }
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (responding) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      respond(declinedClarificationAnswer)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }
  const captureAnswerControl = (element: HTMLSelectElement | HTMLTextAreaElement | null): void => {
    answerControlRef.current = element
  }

  return (
    <Card aria-label="Clarification request" role="group" size="sm">
      <CardHeader>
        <CardTitle>Clarification required</CardTitle>
        <CardDescription className="whitespace-pre-wrap">{request.question}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {request.choices.length > 0 ? (
          <select
            aria-label="Clarification answer"
            className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={responding}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={handleKeyDown}
            ref={captureAnswerControl}
            value={answer}
          >
            {request.choices.map((choice, index) => (
              <option key={`${index}-${choice}`} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        ) : (
          <Textarea
            aria-label="Clarification answer"
            disabled={responding}
            maxLength={maximumClarificationAnswerLength}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Answer"
            ref={captureAnswerControl}
            value={answer}
          />
        )}
        <InteractionStatus request={request} />
      </CardContent>
      <CardFooter className="gap-2">
        <Button
          disabled={responding}
          onClick={() => respond(declinedClarificationAnswer)}
          size="sm"
          type="button"
          variant="destructive"
        >
          Decline
        </Button>
        <Button disabled={responding || !validAnswer} onClick={submit} size="sm" type="button">
          Submit
        </Button>
      </CardFooter>
    </Card>
  )
}

function InteractionRequest({
  onExited,
  primary,
  present,
  request,
  sessionId
}: InteractionRequestProps): React.JSX.Element | null {
  const finishExit = useCallback(() => onExited(request.id), [onExited, request.id])
  const { mounted, handleTransitionEnd } = usePresence(present, finishExit)
  if (!mounted) {
    return null
  }

  return (
    <li
      aria-hidden={present ? undefined : true}
      className="mr-auto w-full max-w-135 translate-y-0 opacity-100 transition-[opacity,transform] duration-(--duration-feedback) ease-(--ease-out) starting:translate-y-1 starting:opacity-0 data-[present=false]:pointer-events-none data-[present=false]:translate-y-1 data-[present=false]:opacity-0 data-[present=false]:duration-100 motion-reduce:transform-none! motion-reduce:transition-opacity! motion-reduce:duration-(--duration-feedback)!"
      data-interaction-type={request.type}
      data-present={present}
      data-slot="interaction-request"
      inert={present ? undefined : true}
      onTransitionEnd={handleTransitionEnd}
    >
      {request.type === 'approval' ? (
        <ApprovalRequest primary={primary} request={request} sessionId={sessionId} />
      ) : (
        <ClarificationRequest primary={primary} request={request} sessionId={sessionId} />
      )}
    </li>
  )
}

interface InteractionRequestLayer {
  present: boolean
  request: TranscriptInteractionRequest
}

interface InteractionRequestState {
  layers: readonly InteractionRequestLayer[]
  sessionId: string
}

function requestLayers(
  requests: readonly TranscriptInteractionRequest[]
): readonly InteractionRequestLayer[] {
  return requests.map((request) => ({ present: true, request }))
}

function reconcileRequestLayers(
  current: readonly InteractionRequestLayer[],
  requests: readonly TranscriptInteractionRequest[]
): readonly InteractionRequestLayer[] {
  const requestById = new Map(requests.map((request) => [request.id, request]))
  const currentIds = new Set(current.map((layer) => layer.request.id))
  const retained = current.map((layer) => {
    const request = requestById.get(layer.request.id)
    if (request) {
      return layer.present && layer.request === request ? layer : { present: true, request }
    }
    return layer.present ? { ...layer, present: false } : layer
  })
  const added = requests
    .filter((request) => !currentIds.has(request.id))
    .map((request) => ({ present: true, request }))
  const next = [...retained, ...added]
  return next.length === current.length && next.every((layer, index) => layer === current[index])
    ? current
    : next
}

export function TaskInteractionRows({
  requests,
  sessionId
}: InteractionRowsProps): React.JSX.Element {
  const [state, setState] = useState<InteractionRequestState>(() => ({
    layers: requestLayers(requests),
    sessionId
  }))
  if (state.sessionId !== sessionId) {
    setState({ layers: requestLayers(requests), sessionId })
  } else {
    const layers = reconcileRequestLayers(state.layers, requests)
    if (layers !== state.layers) {
      setState({ ...state, layers })
    }
  }

  const removeExitedRequest = useCallback((requestId: string): void => {
    setState((current) => {
      const layers = current.layers.filter(
        (layer) => layer.request.id !== requestId || layer.present
      )
      return layers.length === current.layers.length ? current : { ...current, layers }
    })
  }, [])

  const primaryRequestId = requests[0]?.id

  return (
    <>
      {state.layers.map((layer) => (
        <InteractionRequest
          key={`${state.sessionId}:${layer.request.id}`}
          onExited={removeExitedRequest}
          present={layer.present}
          primary={layer.present && layer.request.id === primaryRequestId}
          request={layer.request}
          sessionId={sessionId}
        />
      ))}
    </>
  )
}
