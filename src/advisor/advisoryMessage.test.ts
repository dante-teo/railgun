import { describe, expect, it } from "vitest";
import type { DevinMessage } from "widevin";
import { normalizeAdvisoryHistory, parseAdvisoryMessage } from "./advisoryMessage.js";

describe("advisory messages", () => {
  it("removes private advisory prompts and merges the assistant correction", () => {
    const messages: readonly DevinMessage[] = [
      { role: "user", content: "Build it" },
      { role: "assistant", content: [{ type: "text", text: "Initial. " }] },
      { role: "user", content: '<advisory severity="concern">Check it</advisory>' },
      { role: "assistant", content: [{ type: "text", text: "Corrected." }] },
    ];

    expect(normalizeAdvisoryHistory(messages)).toEqual([
      { role: "user", content: "Build it" },
      { role: "assistant", content: [{ type: "text", text: "Initial. " }, { type: "text", text: "Corrected." }] },
    ]);
  });

  it("parses escaped display text", () => {
    expect(parseAdvisoryMessage('<advisory severity="nit">Use &lt;x&gt; &amp; y</advisory>'))
      .toEqual({ severity: "nit", text: "Use <x> & y" });
  });
});
