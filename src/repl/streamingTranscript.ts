export interface StreamSegments {
  readonly segment: string;
  readonly flushed: string;
}

export const createStreamSegments = (): StreamSegments => ({ segment: "", flushed: "" });

export const appendStreamDelta = (state: StreamSegments, delta: string): StreamSegments => ({
  ...state,
  segment: state.segment + delta,
});

export const flushStreamSegment = (
  state: StreamSegments,
): { readonly state: StreamSegments; readonly line: string | null } => ({
  state: { segment: "", flushed: state.flushed + state.segment },
  line: state.segment === "" ? null : state.segment,
});

export const finishStreamSegments = (assistantText: string, state: StreamSegments): string =>
  assistantText.startsWith(state.flushed)
    ? assistantText.slice(state.flushed.length)
    : state.segment || assistantText;
