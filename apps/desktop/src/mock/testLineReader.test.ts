import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLineReader } from "./testLineReader";

describe("mock test line reader", () => {
  it("preserves every line when multiple frames arrive in one chunk", async () => {
    const stream = new PassThrough();
    const nextLine = createLineReader(stream);
    stream.write("first\nsecond\n");
    expect(await nextLine()).toEqual({ line: "first", chunks: 1 });
    expect(await nextLine()).toEqual({ line: "second", chunks: 1 });
  });
});
