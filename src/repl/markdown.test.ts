import { describe, expect, it } from "vitest";
import { renderAssistantMarkdown } from "./markdown.js";
import { THEMES } from "./theme.js";

describe("assistant Markdown", () => {
  it("renders GFM headings, lists, links, and tables within the requested width", () => {
    const output = renderAssistantMarkdown("# Title\n\n- **mint** [link](https://example.com)\n\n| A | B |\n|---|---|\n| 1 | 2 |", THEMES.dark, 34);
    expect(output).toContain("Title");
    expect(output).toContain("mint");
    expect(output).toContain("A");
    expect(output.split("\n").every(line => line.length < 160)).toBe(true);
  });

  it("renders themed fenced code boxes with language labels in both modes", () => {
    const markdown = "```ts\nconst mint = true;\n```";
    const dark = renderAssistantMarkdown(markdown, THEMES.dark, 60);
    const light = renderAssistantMarkdown(markdown, THEMES.light, 60);
    expect(dark).toContain("[ts]");
    expect(dark).toContain("const mint = true;");
    expect(dark).not.toBe(light);
  });

  it("keeps narrow rendering usable", () => {
    const output = renderAssistantMarkdown("A very long assistant sentence that must wrap safely.", THEMES.light, 12);
    expect(output.split("\n").length).toBeGreaterThan(1);
  });
});
