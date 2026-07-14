import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Bot, Send, Square } from "lucide-react";
import type { BackendSnapshot, DesktopAgentEvent } from "../../shared/types";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/input";
import { EmptyState } from "../components/ui/state";
import { BackendStatus } from "../backendStatus";
import { chatReducer, initialChatState } from "./chatState";
import type { QueueKind } from "./chatState";
import { MarkdownMessage } from "./MarkdownMessage";
import { createDeltaFrameBuffer } from "./streaming";
import { errorMessage } from "../lib/utils";

const nextFrame = (callback: FrameRequestCallback): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : window.setTimeout(() => callback(performance.now()), 16);

const cancelFrame = (handle: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else window.clearTimeout(handle);
};

export const useChatController = (snapshot: BackendSnapshot | undefined) => {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const stateRef = useRef(state);
  const nextId = useRef(1);
  const stoppingRef = useRef(false);
  stateRef.current = state;
  stoppingRef.current = state.stopping;

  const makeId = useCallback((prefix: string): string => `${prefix}-${String(nextId.current++)}`, []);
  const deltaBuffer = useRef<ReturnType<typeof createDeltaFrameBuffer> | undefined>(undefined);
  if (deltaBuffer.current === undefined) {
    deltaBuffer.current = createDeltaFrameBuffer(
      text => dispatch({ type: "assistant-delta", id: makeId("assistant"), text }),
      nextFrame,
      cancelFrame,
    );
  }

  useEffect(() => {
    const handleEvent = (event: DesktopAgentEvent): void => {
      switch (event.type) {
        case "run-start": dispatch({ type: "run-start" }); break;
        case "run-end": deltaBuffer.current?.flush(); dispatch({ type: "run-end" }); break;
        case "assistant-delta": deltaBuffer.current?.push(event.text); break;
        case "assistant-complete": deltaBuffer.current?.flush(); dispatch({ type: "assistant-complete" }); break;
        case "queue-update": dispatch({ type: "queue-update", steering: event.steering, followUp: event.followUp }); break;
      }
    };
    const unsubscribe = window.railgunDesktop.onAgentEvent(handleEvent);
    return () => { deltaBuffer.current?.clear(); unsubscribe(); };
  }, []);

  useEffect(() => {
    if (snapshot !== undefined && snapshot.phase !== "ready") {
      deltaBuffer.current?.flush();
      dispatch({ type: "backend-failed", error: snapshot.error ?? "The backend connection was interrupted" });
    }
  }, [snapshot?.phase, snapshot?.error]);

  const performInitial = async (userId: string, text: string): Promise<void> => {
    try {
      await window.railgunDesktop.sendPrompt(text);
    } catch (error) {
      deltaBuffer.current?.flush();
      dispatch({ type: "request-failed", userId, text, error: errorMessage(error, "The request failed") });
    }
  };

  const sendInitial = async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || snapshot?.phase !== "ready" || stateRef.current.running) return;
    const userId = makeId("user");
    setDraft("");
    dispatch({ type: "initial-submit", id: userId, text });
    await performInitial(userId, text);
  };

  const retry = async (): Promise<void> => {
    const failedRun = stateRef.current.failedRun;
    if (failedRun === undefined || snapshot?.phase !== "ready" || stateRef.current.running) return;
    dispatch({ type: "retry-start" });
    await performInitial(failedRun.userId, failedRun.text);
  };

  const queueDraft = async (kind: QueueKind): Promise<void> => {
    const source = draft;
    const text = source.trim();
    if (text === "" || snapshot?.phase !== "ready" || !stateRef.current.running || stateRef.current.stopping) return;
    try {
      if (kind === "steering") await window.railgunDesktop.steerPrompt(text);
      else await window.railgunDesktop.followUpPrompt(text);
      if (!stateRef.current.running || stateRef.current.stopping) return;
      dispatch({ type: "queue-accepted", id: makeId("queued"), kind, text });
      setDraft(current => current === source ? "" : current);
    } catch (error) {
      dispatch({ type: "queue-rejected", error: errorMessage(error, `Unable to queue ${kind}`) });
    }
  };

  const stop = async (): Promise<boolean> => {
    if (!stateRef.current.running || stoppingRef.current) return false;
    stoppingRef.current = true;
    dispatch({ type: "stop-request" });
    try {
      await window.railgunDesktop.abortPrompt();
      dispatch({ type: "stop-acknowledged" });
      return true;
    } catch (error) {
      stoppingRef.current = false;
      dispatch({ type: "stop-failed", error: errorMessage(error, "Unable to stop the request") });
      return false;
    }
  };

  const reset = (): void => {
    deltaBuffer.current?.clear();
    setDraft("");
    dispatch({ type: "reset" });
  };

  return { state, draft, setDraft, sendInitial, retry, queueDraft, stop, reset };
};

export type ChatController = ReturnType<typeof useChatController>;

interface TranscriptProps {
  readonly controller: ChatController;
  readonly snapshot: BackendSnapshot;
  readonly onRestart: () => Promise<void>;
}

export const Transcript = ({ controller, snapshot, onRestart }: TranscriptProps): React.JSX.Element => {
  const { state } = controller;
  return (
    <div className={`transcript ${state.messages.length === 0 ? "empty" : ""}`} aria-live="polite">
      {state.messages.length === 0 && snapshot.phase === "ready"
        ? <EmptyState className="welcome" icon={<Bot />} title="What are we building?" description="Ask Railgun to inspect, explain, or change your project." />
        : null}
      {state.messages.length === 0 && snapshot.phase !== "ready"
        ? <BackendStatus snapshot={snapshot} onRetry={onRestart} />
        : null}
      {state.messages.map(message => (
        <article className={`message ${message.role} ${message.status}`} key={message.id} data-status={message.status}>
          <div className="message-role">{message.role === "user" ? "You" : "Railgun"}</div>
          {message.role === "assistant" && message.status !== "streaming"
            ? <MarkdownMessage>{message.text}</MarkdownMessage>
            : <p>{message.text}</p>}
          {message.status === "stopped" ? <span className="message-status">Stopped</span> : null}
        </article>
      ))}
      {state.failedRun === undefined ? null : (
        <div className="run-error" role="alert">
          <span>{state.failedRun.error}</span>
          {snapshot.phase === "ready"
            ? <Button type="button" size="sm" variant="glass" onClick={() => void controller.retry()}>Retry</Button>
            : <Button type="button" size="sm" variant="glass" onClick={() => void onRestart()}>Restart backend</Button>}
        </div>
      )}
      {state.running && state.messages.at(-1)?.role !== "assistant"
        ? <div className="thinking"><i /><i /><i /><span>Railgun is thinking</span></div>
        : null}
    </div>
  );
};

interface ComposerProps {
  readonly controller: ChatController;
  readonly available: boolean;
}

export const Composer = ({ controller, available }: ComposerProps): React.JSX.Element => {
  const { state, draft } = controller;
  return (
    <div className="composer-wrap">
      {state.queue.length === 0 ? null : (
        <section className="prompt-queue" aria-label="Queued messages">
          <h2>Queued</h2>
          <ol>{state.queue.map(item => <li key={item.id}><span>{item.kind === "steering" ? "Steering" : "Follow-up"}</span><p>{item.text}</p></li>)}</ol>
        </section>
      )}
      <div className="composer">
        <Textarea
          aria-label="Message Railgun"
          placeholder={available ? "Message Railgun…" : "Backend unavailable"}
          value={draft}
          disabled={!available}
          onChange={event => controller.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (state.running) void controller.queueDraft("steering");
              else void controller.sendInitial();
            } else if (event.key === "Tab" && state.running && draft.trim() !== "") {
              event.preventDefault();
              void controller.queueDraft("follow-up");
            }
          }}
        />
        {state.running ? (
          <Button variant="destructive" size="icon" className="send-button" aria-label="Stop" disabled={state.stopping} onClick={() => void controller.stop()}><Square aria-hidden="true" /></Button>
        ) : (
          <Button size="icon" className="send-button" aria-label="Send" disabled={draft.trim() === "" || !available} onClick={() => void controller.sendInitial()}><Send aria-hidden="true" /></Button>
        )}
      </div>
      {state.submissionError === undefined ? null : <p className="composer-error" role="alert">{state.submissionError}</p>}
      <p className="composer-hint">{state.running ? "Enter steers · Tab queues follow-up · Shift+Enter adds a line" : "Enter sends · Shift+Enter adds a line"}</p>
    </div>
  );
};
