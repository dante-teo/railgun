import { describe, expect, it } from "vitest";
import { mapToolKind } from "./toolKind.js";

describe("mapToolKind", () => {
  it("maps read tools to 'read'", () => {
    expect(mapToolKind("readFile")).toBe("read");
    expect(mapToolKind("listDirectory")).toBe("read");
    expect(mapToolKind("skillView")).toBe("read");
  });

  it("maps writeFile to 'edit'", () => {
    expect(mapToolKind("writeFile")).toBe("edit");
  });

  it("maps runShell to 'execute'", () => {
    expect(mapToolKind("runShell")).toBe("execute");
  });

  it("maps todo to 'think'", () => {
    expect(mapToolKind("todo")).toBe("think");
  });

  it("maps memory/advise/clarify to 'other'", () => {
    expect(mapToolKind("memory")).toBe("other");
    expect(mapToolKind("advise")).toBe("other");
    expect(mapToolKind("clarify")).toBe("other");
  });

  it("maps unknown tools to 'other'", () => {
    expect(mapToolKind("unknownTool")).toBe("other");
    expect(mapToolKind("")).toBe("other");
  });
});
