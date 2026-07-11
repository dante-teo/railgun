import type { Readable } from "node:stream";

export const serializeJsonLine = (value: unknown): string =>
  JSON.stringify(value) + "\n";

export type LineReaderCleanup = () => void;

export const makeLineReader = (
  stream: Readable,
  onLine: (line: string) => void,
): LineReaderCleanup => {
  let buffer = Buffer.alloc(0);

  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    let i: number;
    while ((i = buffer.indexOf(0x0a)) !== -1) {
      const lineBytes = buffer.subarray(0, i);
      buffer = buffer.subarray(i + 1);
      const line = lineBytes.toString("utf-8");
      if (line.length > 0) onLine(line);
    }
  };

  stream.on("data", onData);
  return () => stream.off("data", onData);
};
