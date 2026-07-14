export interface DeltaFrameBuffer {
  readonly push: (text: string) => void;
  readonly flush: () => void;
  readonly clear: () => void;
}

export const createDeltaFrameBuffer = (
  onFlush: (text: string) => void,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (handle: number) => void = cancelAnimationFrame,
): DeltaFrameBuffer => {
  let pending = "";
  let frame: number | undefined;

  const flush = (): void => {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    if (pending === "") return;
    const text = pending;
    pending = "";
    onFlush(text);
  };

  return {
    push: (text) => {
      pending += text;
      if (frame !== undefined) return;
      frame = requestFrame(() => {
        frame = undefined;
        flush();
      });
    },
    flush,
    clear: () => {
      if (frame !== undefined) cancelFrame(frame);
      frame = undefined;
      pending = "";
    },
  };
};
