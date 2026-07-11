import { describe, expect, it } from "vitest";
import { buildToolLabel } from "./toolLabel.js";
import { registry } from "./registry.js";
import "./index.js";

describe("buildToolLabel", () => {
  it("formats read_file as 'Reading <path>'", () => {
    expect(buildToolLabel("read_file", { path: "/tmp/notes.txt" })).toBe("Reading /tmp/notes.txt");
  });

  it("formats write_file as 'Writing <path>'", () => {
    expect(buildToolLabel("write_file", { path: "/tmp/out.txt", content: "hi" })).toBe("Writing /tmp/out.txt");
  });

  it("formats list_directory as 'Listing <path>'", () => {
    expect(buildToolLabel("list_directory", { path: "/tmp" })).toBe("Listing /tmp");
  });

  it("formats run_shell_command as 'Running <command>'", () => {
    expect(buildToolLabel("run_shell_command", { command: "echo hi" })).toBe("Running echo hi");
  });

  it("falls back to name+JSON for an unregistered tool name", () => {
    expect(buildToolLabel("totally_unknown_tool", { foo: "bar" })).toBe('totally_unknown_tool {"foo":"bar"}');
  });

  it("falls back to name+JSON when a registered tool has no verb/previewArgKey", () => {
    registry.register({
      name: "bare_tool",
      toolset: "file",
      schema: { name: "bare_tool", description: "bare", inputSchema: {} },
      handler: async () => ({ content: "", isError: false })
    });

    expect(buildToolLabel("bare_tool", { x: 1 })).toBe('bare_tool {"x":1}');
  });

  it("falls back to name+JSON when the registered tool's preview arg is missing", () => {
    expect(buildToolLabel("read_file", {})).toBe("read_file {}");
  });

  it("falls back to name+JSON when the registered tool's preview arg is non-string", () => {
    expect(buildToolLabel("read_file", { path: 42 })).toBe('read_file {"path":42}');
  });

  it("collapses embedded newlines and whitespace runs to single spaces", () => {
    expect(buildToolLabel("read_file", { path: "line1\n\nline2   line3" })).toBe("Reading line1 line2 line3");
  });

  it("truncates a label over 60 chars to 57 chars plus a trailing ellipsis", () => {
    const longPath = "/very/long/path/" + "x".repeat(80);
    const label = buildToolLabel("read_file", { path: longPath });

    expect(label).toHaveLength(60);
    expect(label.endsWith("...")).toBe(true);
    expect(label.startsWith(`Reading ${longPath}`.slice(0, 57))).toBe(true);
  });

  it("registry is populated with the real tools this suite depends on", () => {
    expect(registry.get("read_file")?.verb).toBe("Reading");
  });
});
