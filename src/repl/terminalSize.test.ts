import { describe, expect, it } from "vitest";
import { readTerminalSize } from "./terminalSize.js";

describe("readTerminalSize", () => {
  it("uses current terminal dimensions and stable non-TTY fallbacks", () => {
    expect(readTerminalSize({ columns: 132, rows: 42 })).toEqual({ columns: 132, rows: 42 });
    expect(readTerminalSize({})).toEqual({ columns: 80, rows: 24 });
  });
});
