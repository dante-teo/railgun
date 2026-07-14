import type { Readable } from "node:stream";

export interface LineRead {
  readonly line: string;
  readonly chunks: number;
}

export const createLineReader = (stream: Readable): (() => Promise<LineRead>) => {
  const queued: LineRead[] = [];
  const waiting: Array<{ readonly resolve: (line: LineRead) => void; readonly reject: (error: Error) => void }> = [];
  let buffer = "";
  let chunks = 0;
  let terminalError: Error | undefined;

  const deliver = (line: LineRead): void => {
    const waiter = waiting.shift();
    if (waiter === undefined) queued.push(line);
    else waiter.resolve(line);
  };
  const finish = (error: Error): void => {
    terminalError = error;
    waiting.splice(0).forEach(waiter => waiter.reject(error));
  };

  stream.on("data", (chunk: Buffer | string) => {
    chunks += 1;
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      deliver({ line: buffer.slice(0, newline), chunks });
      buffer = buffer.slice(newline + 1);
      chunks = buffer.length === 0 ? 0 : 1;
      newline = buffer.indexOf("\n");
    }
  });
  stream.once("end", () => finish(new Error("mock output ended before a frame")));
  stream.once("error", error => finish(error));

  return () => {
    const line = queued.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (terminalError !== undefined) return Promise.reject(terminalError);
    return new Promise<LineRead>((resolve, reject) => waiting.push({ resolve, reject }));
  };
};
