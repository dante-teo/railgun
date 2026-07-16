// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSummary } from "../../shared/types";
import { AppSidebar } from "./AppSidebar";

afterEach(cleanup);

describe("AppSidebar", () => {
  const commonProps = {
    phase: "ready" as const,
    sessions: [] as readonly SessionSummary[],
    sessionsLoading: false,
    busy: false,
    running: false,
    onNewTask: () => undefined,
    onScheduled: () => undefined,
    onSettings: () => undefined,
    onRetrySessions: () => undefined,
    onResumeSession: () => undefined,
    onOpenSessionMenu: () => undefined,
    onArchiveSession: () => undefined,
  };

  it("marks Settings as the current sidebar destination", () => {
    render(<AppSidebar area="settings" {...commonProps} />);

    const settings = screen.getByRole("button", { name: "Settings" });
    expect(settings.getAttribute("aria-current")).toBe("page");
    expect(settings.className).toContain("bg-accent");
    expect(screen.getByRole("button", { name: "Scheduled" }).getAttribute("aria-current")).toBeNull();
  });

  it("gives each archive action a task-specific accessible name", () => {
    const sessions: readonly SessionSummary[] = [
      { id: "one", model: "Model A", startedAtLocal: "today", messageCount: 1, firstUserPreview: "First task" },
      { id: "two", model: "Model B", startedAtLocal: "yesterday", messageCount: 2, firstUserPreview: "Second task" },
    ];
    render(<AppSidebar
      area="chat"
      phase="ready"
      sessions={sessions}
      sessionsLoading={false}
      busy={false}
      running={false}
      onNewTask={() => undefined}
      onScheduled={() => undefined}
      onSettings={() => undefined}
      onRetrySessions={() => undefined}
      onResumeSession={() => undefined}
      onOpenSessionMenu={() => undefined}
      onArchiveSession={() => undefined}
    />);

    expect(screen.getByRole("button", { name: "Archive First task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive Second task" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive task" })).toBeNull();
  });
});
