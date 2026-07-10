import { describe, expect, it } from "vitest";
import { parseMouseWheel } from "./mouse.js";

describe("parseMouseWheel", () => {
  it("parses SGR wheel events and ignores clicks or unrelated input", () => {
    expect(parseMouseWheel("\u001b[<64;20;8M")).toEqual(["up"]);
    expect(parseMouseWheel("\u001b[<65;20;8M")).toEqual(["down"]);
    expect(parseMouseWheel("\u001b[<0;20;8M")).toEqual([]);
    expect(parseMouseWheel("hello")).toEqual([]);
  });

  it("keeps multiple wheel ticks from a single input chunk", () => {
    expect(parseMouseWheel("\u001b[<64;1;1M\u001b[<64;1;1M")).toEqual(["up", "up"]);
  });
});
