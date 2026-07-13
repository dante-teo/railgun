import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DisplayLine } from "@railgun/core/repl/App.js";
import type { AdviceSeverity } from "@railgun/core/advisor/advisoryContext.js";
import { StreamingCursor } from "./StreamingCursor.js";
import { ToolCallLine, type ToolCallState } from "./ToolCallLine.js";

const TOOL_STATE = (line: DisplayLine): ToolCallState => {
  if (line.pending) return "running";
  if (line.failed) return "error";
  return "done";
};

const advisoryModifier = (severity: AdviceSeverity | undefined): string => {
  if (severity === "blocker") return "advisory--error";
  if (severity === "concern") return "advisory--warning";
  return "advisory--success";
};

const LABEL: Record<DisplayLine["kind"], string> = {
  user: "YOU",
  assistant: "RAILGUN",
  tool: "",
  error: "ERROR",
  advisory: "ADVISOR",
};

interface MessageBubbleProps {
  readonly line: DisplayLine;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ line }) => {
  if (line.kind === "tool") {
    return <ToolCallLine label={line.text} state={TOOL_STATE(line)} />;
  }

  const advisoryClass = line.kind === "advisory" ? ` ${advisoryModifier(line.severity)}` : "";
  const containerClass = `message message--${line.kind}${advisoryClass}`;

  const label = LABEL[line.kind];

  return (
    <div className={containerClass} role="article">
      {label && (
        <span className="message__label">{label}</span>
      )}
      <div className="message__body">
        {line.kind === "assistant" ? (
          line.partial && !line.text ? (
            <span className="thinking-text">Thinking<StreamingCursor /></span>
          ) : (
            <>
              <Markdown remarkPlugins={[remarkGfm]}>{line.text}</Markdown>
              {line.partial && <StreamingCursor />}
            </>
          )
        ) : (
          <span>{line.text}</span>
        )}
      </div>
    </div>
  );
};

