// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RailgunDesktopApi } from "../../shared/types";
import { KnowledgePage } from "./KnowledgePage";

afterEach(cleanup);

describe("KnowledgePage", () => {
  it("filters skills, renders sanitized detail, and exposes invocation status", async () => {
    const listSkills = vi.fn(async () => [
      { name: "testing", description: "Test desktop flows", disableModelInvocation: false },
      { name: "release", description: "Review a release", disableModelInvocation: true },
    ]);
    const getSkill = vi.fn(async (name: string) => ({
      name,
      description: name === "release" ? "Review a release" : "Test desktop flows",
      disableModelInvocation: name === "release",
      body: `# ${name}\n\n<script>unsafe()</script>Safe body`,
    }));
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: { listSkills, getSkill, openExternal: vi.fn() } as unknown as RailgunDesktopApi });
    render(<KnowledgePage onBack={vi.fn()} />);
    expect(await screen.findByText("Available to model")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), { target: { value: "release" } });
    expect(screen.queryByRole("button", { name: /testing/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /release/u }));
    expect(await screen.findByText("Model invocation disabled")).toBeTruthy();
    await waitFor(() => expect(getSkill).toHaveBeenLastCalledWith("release"));
  });

  it("shows list loading, empty, error, and retry states", async () => {
    const listSkills = vi.fn().mockRejectedValueOnce(new Error("store offline")).mockResolvedValueOnce([]);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: { listSkills, getSkill: vi.fn(), openExternal: vi.fn() } as unknown as RailgunDesktopApi });
    render(<KnowledgePage onBack={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Loading skills");
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No skills installed")).toBeTruthy();
  });
});
