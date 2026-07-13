import React, { useEffect, useRef, useState } from "react";
import type { DisplayLine } from "@railgun/core/repl/App.js";
import { glyphs } from "../lib/theme.js";
import { MessageBubble } from "./MessageBubble.js";

interface TranscriptProps {
  readonly lines: readonly DisplayLine[];
  readonly streaming: string;
  readonly busy: boolean;
}

export const Transcript: React.FC<TranscriptProps> = ({ lines, streaming, busy }) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [unseenCount, setUnseenCount] = useState(0);
  const isAtBottomRef = useRef(true);

  const scrollToBottom = (): void => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setUnseenCount(0);
  };

  // Track scroll position
  const handleScroll = (): void => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distanceFromBottom < 40;
    if (isAtBottomRef.current) setUnseenCount(0);
  };

  // Auto-scroll on new content
  useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    } else {
      setUnseenCount(c => c + 1);
    }
  }, [lines.length, streaming]);

  return (
    <div
      className="transcript"
      ref={containerRef}
      onScroll={handleScroll}
      role="log"
      aria-live="polite"
      aria-label="Conversation transcript"
    >
      {lines.map((line, i) => (
        <MessageBubble key={i} line={line} />
      ))}

      {/* Live streaming assistant line */}
      {busy && streaming.length > 0 && (
        <MessageBubble
          line={{ kind: "assistant", text: streaming, partial: true }}
        />
      )}

      {/* Thinking indicator — busy but no text yet */}
      {busy && !streaming && (
        <MessageBubble line={{ kind: "assistant", text: "", partial: true }} />
      )}

      <div ref={bottomRef} />

      {unseenCount > 0 && (
        <button
          className="transcript__unseen-pill"
          onClick={scrollToBottom}
          aria-label={`${unseenCount} new messages`}
          type="button"
        >
          {glyphs.unseenMessages} {unseenCount} new
        </button>
      )}
    </div>
  );
};
