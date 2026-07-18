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

  it("shows only the current task's working or just-completed status", () => {
    const sessions: readonly SessionSummary[] = [
      { id: "working", model: "Model A", startedAtLocal: "today", messageCount: 1, firstUserPreview: "Working task" },
      { id: "idle", model: "Model B", startedAtLocal: "yesterday", messageCount: 2, firstUserPreview: "Idle task" },
    ];
    const { rerender } = render(<AppSidebar area="chat" {...commonProps} sessions={sessions} sessionActivity={{ sessionId: "working", state: "working" }} />);

    const working = screen.getByRole("status", { name: "Agent working" });
    expect(working.querySelector(".lucide-loader-circle")?.getAttribute("class")).toContain("animate-spin");
    expect(screen.queryByRole("img", { name: "Agent completed" })).toBeNull();

    rerender(<AppSidebar area="chat" {...commonProps} sessions={sessions} sessionActivity={{ sessionId: "working", state: "completed" }} />);

    const completed = screen.getByRole("img", { name: "Agent completed" });
    expect(completed.className).toContain("text-success");
    expect(screen.queryByRole("status", { name: "Agent working" })).toBeNull();

    rerender(<AppSidebar area="chat" {...commonProps} sessions={sessions} />);

    expect(screen.queryByRole("status", { name: "Agent working" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Agent completed" })).toBeNull();
  });

  it("exposes scheduled and unread task indicators with accessible semantics", () => {
    const scheduled: SessionSummary = {
      id: "cron-1",
      model: "Model A",
      startedAtLocal: "today",
      messageCount: 2,
      firstUserPreview: "Daily summary",
      delivery: { kind: "scheduled", jobId: "job-1", title: "Daily summary", status: "incomplete", unread: true },
    };
    render(<AppSidebar area="chat" {...commonProps} sessions={[scheduled]} activeSessionId="cron-1" />);

    const task = screen.getByRole("button", { name: "Unread scheduled task: Daily summary" });
    expect(task.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("img", { name: "Scheduled task" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Unread" })).toBeTruthy();
  });
});
