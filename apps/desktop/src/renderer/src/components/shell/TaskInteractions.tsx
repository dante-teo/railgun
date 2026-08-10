import { useEffect, useRef, useState } from 'react'

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

interface InteractionRowsProps {
  requests: readonly TranscriptInteractionRequest[]
  sessionId: string
}

interface InteractionRequestProps {
  primary: boolean
  request: TranscriptInteractionRequest
  sessionId: string
}

function InteractionStatus({
  request
}: {
  request: TranscriptInteractionRequest
}): React.JSX.Element | null {
  if (request.status === 'responding') {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Submitting response…
      </p>
    )
  }
  return request.error ? (
    <p className="text-xs text-destructive" role="alert">
      {request.error}
    </p>
  ) : null
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
        <CardDescription>Allow this command to run?</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <pre
          aria-label="Command preview"
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
            className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
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
  primary,
  request,
  sessionId
}: InteractionRequestProps): React.JSX.Element {
  return (
    <li className="mr-auto w-full max-w-135" data-interaction-type={request.type}>
      {request.type === 'approval' ? (
        <ApprovalRequest primary={primary} request={request} sessionId={sessionId} />
      ) : (
        <ClarificationRequest primary={primary} request={request} sessionId={sessionId} />
      )}
    </li>
  )
}

export function TaskInteractionRows({
  requests,
  sessionId
}: InteractionRowsProps): React.JSX.Element {
  return (
    <>
      {requests.map((request, index) => (
        <InteractionRequest
          key={request.id}
          primary={index === 0}
          request={request}
          sessionId={sessionId}
        />
      ))}
    </>
  )
}
