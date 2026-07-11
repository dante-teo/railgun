import { describe, expect, it } from "vitest";
import { appendStreamDelta, createStreamSegments, finishStreamSegments, flushStreamSegment } from "./streamingTranscript.js";

describe("streaming transcript segments", () => {
  it("flushes agent narration before each tool instead of pinning it after tools", () => {
    const transcript: string[] = ["USER query"];
    let stream = appendStreamDelta(createStreamSegments(), "I will inspect it.");
    const first = flushStreamSegment(stream);
    stream = first.state;
    if (first.line) transcript.push(`AGENT ${first.line}`);
    transcript.push("TOOL read");

    stream = appendStreamDelta(stream, "I found it; now I will edit.");
    const second = flushStreamSegment(stream);
    stream = second.state;
    if (second.line) transcript.push(`AGENT ${second.line}`);
    transcript.push("TOOL write");

    stream = appendStreamDelta(stream, "Done.");
    transcript.push(`AGENT ${finishStreamSegments("I will inspect it.I found it; now I will edit.Done.", stream)}`);

    expect(transcript).toEqual([
      "USER query",
      "AGENT I will inspect it.",
      "TOOL read",
      "AGENT I found it; now I will edit.",
      "TOOL write",
      "AGENT Done.",
    ]);
  });

  it("uses a synthetic final answer when no streamed segment exists", () => {
    expect(finishStreamSegments("Iteration limit reached.", createStreamSegments())).toBe("Iteration limit reached.");
  });

  it("keeps a queued user message after the assistant boundary it follows", () => {
    const transcript: string[] = [];
    let stream = appendStreamDelta(createStreamSegments(), "First response.");
    const boundary = flushStreamSegment(stream);
    stream = boundary.state;
    if (boundary.line) transcript.push(`AGENT ${boundary.line}`);
    transcript.push("USER steer here");
    stream = appendStreamDelta(stream, "Second response.");
    transcript.push(`AGENT ${finishStreamSegments("First response.Second response.", stream)}`);

    expect(transcript).toEqual([
      "AGENT First response.",
      "USER steer here",
      "AGENT Second response.",
    ]);
  });

  it("returns only the unflushed suffix when an interrupted run already displayed narration", () => {
    const flushed = flushStreamSegment(appendStreamDelta(createStreamSegments(), "Before tool.")).state;
    const interrupted = appendStreamDelta(flushed, "After tool.");

    expect(finishStreamSegments("Before tool.After tool.", interrupted)).toBe("After tool.");
  });
});
