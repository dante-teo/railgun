// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownMessage, safeExternalUrl } from "./MarkdownMessage";

afterEach(cleanup);

describe("completed Markdown", () => {
  it("renders GFM, labelled fenced code, and opens safe links through the bridge", () => {
    const openExternal = vi.fn(async () => undefined);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: { openExternal } });
    render(<MarkdownMessage>{`# Heading\n\n- item\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n\`inline\`\n\n\`\`\`ts\nconst ok = true;\n\`\`\`\n\n[Docs](https://example.com/docs)`}</MarkdownMessage>);
    expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(document.querySelector("code[data-language='ts']")?.textContent).toContain("const ok");
    fireEvent.click(screen.getByRole("link", { name: "Docs" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("drops raw HTML and does not create links for unsafe or malformed URLs", () => {
    render(<MarkdownMessage>{`<script>alert(1)</script><b>raw</b>\n\n[bad](javascript:alert(1)) [relative](/secret) [broken](not a url)`}</MarkdownMessage>);
    expect(document.querySelector("script, b")).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(safeExternalUrl("file:///tmp/secret")).toBeUndefined();
    expect(safeExternalUrl("https://example.com")).toBe("https://example.com/");
  });
});
