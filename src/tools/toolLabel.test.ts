import { describe, expect, it } from "vitest";
import { buildToolLabel } from "./toolLabel.js";
import { registry } from "./registry.js";
import "./index.js";

describe("buildToolLabel", () => {
  it.each(["start", "complete"] as const)("formats read_file as 'Reading <path>' for phase %s", phase => {
    expect(buildToolLabel("read_file", { path: "/tmp/notes.txt" }, phase)).toBe("Reading /tmp/notes.txt");
  });

  it.each(["start", "complete"] as const)("formats write_file as 'Writing <path>' for phase %s", phase => {
    expect(buildToolLabel("write_file", { path: "/tmp/out.txt", content: "hi" }, phase)).toBe("Writing /tmp/out.txt");
  });

  it.each(["start", "complete"] as const)("formats list_directory as 'Listing <path>' for phase %s", phase => {
    expect(buildToolLabel("list_directory", { path: "/tmp" }, phase)).toBe("Listing /tmp");
  });

  it.each(["start", "complete"] as const)("formats run_shell_command as 'Running <command>' for phase %s", phase => {
    expect(buildToolLabel("run_shell_command", { command: "echo hi" }, phase)).toBe("Running echo hi");
  });

  it("falls back to name+JSON for an unregistered tool name", () => {
    expect(buildToolLabel("totally_unknown_tool", { foo: "bar" }, "start")).toBe('totally_unknown_tool {"foo":"bar"}');
  });

  it("falls back to name+JSON when a registered tool has no verb/previewArgKey", () => {
    registry.register({
      name: "bare_tool",
      toolset: "file",
      schema: { name: "bare_tool", description: "bare", inputSchema: {} },
      handler: async () => ({ content: "", isError: false })
    });

    expect(buildToolLabel("bare_tool", { x: 1 }, "start")).toBe('bare_tool {"x":1}');
  });

  it("falls back to name+JSON when the registered tool's preview arg is missing", () => {
    expect(buildToolLabel("read_file", {}, "start")).toBe("read_file {}");
  });

  it("falls back to name+JSON when the registered tool's preview arg is non-string", () => {
    expect(buildToolLabel("read_file", { path: 42 }, "start")).toBe('read_file {"path":42}');
  });

  it("phrases the __batch__ sentinel differently for start vs complete", () => {
    expect(buildToolLabel("__batch__", { count: 3 }, "start")).toBe("Running 3 tools concurrently");
    expect(buildToolLabel("__batch__", { count: 3 }, "complete")).toBe("3/3 tools completed");
  });

  it("collapses embedded newlines and whitespace runs to single spaces", () => {
    expect(buildToolLabel("read_file", { path: "line1\n\nline2   line3" }, "start")).toBe("Reading line1 line2 line3");
  });

  it("truncates a label over 60 chars to 57 chars plus a trailing ellipsis", () => {
    const longPath = "/very/long/path/" + "x".repeat(80);
    const label = buildToolLabel("read_file", { path: longPath }, "start");

    expect(label).toHaveLength(60);
    expect(label.endsWith("...")).toBe(true);
    expect(label.startsWith(`Reading ${longPath}`.slice(0, 57))).toBe(true);
  });

  it("registry is populated with the real tools this suite depends on", () => {
    expect(registry.get("read_file")?.verb).toBe("Reading");
  });
});
