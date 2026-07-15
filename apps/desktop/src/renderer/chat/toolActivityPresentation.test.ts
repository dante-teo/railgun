import { describe, expect, it } from "vitest";
import { presentToolActivity } from "./toolActivityPresentation";

describe("presentToolActivity", () => {
  it("uses a concise past-tense action and filename for completed file edits", () => {
    expect(presentToolActivity("write_file", '{"path":"apps/desktop/src/renderer/chat/Chat.tsx"}', "success"))
      .toMatchObject({ action: "Edited", target: "Chat.tsx", icon: "file-edit" });
  });

  it("uses the present tense while a tool is running", () => {
    expect(presentToolActivity("read_file", '{"path":"README.md"}', "running"))
      .toMatchObject({ action: "Reading", target: "README.md", icon: "file-read" });
  });

  it("uses the relevant search target instead of rendering raw JSON", () => {
    expect(presentToolActivity("web_search", '{"query":"Railgun desktop"}', "success"))
      .toMatchObject({ action: "Searched", target: "Railgun desktop", icon: "search" });
  });

  it("summarizes delegated work with its goal", () => {
    expect(presentToolActivity("delegate_task", '{"goal":"Inspect the activity transcript"}', "success"))
      .toMatchObject({ action: "Delegated", target: "Inspect the activity transcript", icon: "tool" });
  });

  it("uses the safe restored target when raw input is unavailable", () => {
    expect(presentToolActivity("write_file", undefined, "success", "scheduler.ts"))
      .toMatchObject({ action: "Edited", target: "scheduler.ts", icon: "file-edit" });
  });

  it("falls back to a readable tool name when no target is available", () => {
    const presentation = presentToolActivity("custom_tool", undefined, "success");
    expect(presentation).toMatchObject({ action: "Ran custom tool", icon: "tool" });
    expect(presentation.target).toBeUndefined();
  });

  it("keeps a safe target for an unrecognized restored tool", () => {
    expect(presentToolActivity("custom_tool", undefined, "success", "artifact.json"))
      .toMatchObject({ action: "Ran custom tool", target: "artifact.json", icon: "tool" });
  });
});
